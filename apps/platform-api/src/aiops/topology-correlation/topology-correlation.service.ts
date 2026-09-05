import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EVENT_BUS,
  EventBusUnavailableError,
  EventSubjects,
  buildHeaders,
  type EventBus,
} from '../../messaging';
import { MetricsService } from '../../observability/metrics.service';
import type { CorrelationEvidence } from '../correlation-types';
import {
  TOPOLOGY_REPOSITORY,
  type RelatedEntity,
  type TopologyEntity,
  type TopologyRelationship,
  type TopologyRepository,
} from '../topology.repository';
import {
  loadTopologyCorrelationConfig,
  type TopologyCorrelationConfig,
} from './topology-correlation.config';
import { TopologyCorrelationMetrics } from './topology-correlation.metrics';
import {
  aggregateHopSources,
  aggregatePathConfidence,
} from './topology-correlation.confidence';
import {
  applyTopologyComponent,
  buildBlastRadius,
  clusterNodeKeys,
  clusterSiteId,
  clusterWindowOverlap,
  isInfraKind,
  pickRootCauseKey,
  propagateImpact,
  scoreAlertPairTopology,
  scoreDependencyPath,
  shouldSuppressIndependentIncidents,
  toBlastNode,
  topologyEvidenceStatements,
} from './topology-correlation.scoring';
import type {
  BlastRadius,
  BlastRadiusNode,
  DependencyPathScore,
  PathDirection,
  RelationshipFact,
  RootCauseSuppression,
  TopologyAlertItem,
  TopologyClusterEnrichment,
  TopologyCorrelationApplyInput,
  TopologyCorrelationApplyResult,
  TopologyCorrelationEventPayload,
  TopologyEvidenceSummary,
} from './topology-correlation.types';
import type { ClusterCorrelation } from '../correlation-types';

/**
 * Extensión topológica de CorrelationService V2.
 * No reemplaza clustering, score V1 ni GraphService / TopologyRepository.
 */
@Injectable()
export class TopologyCorrelationService {
  private readonly logger = new Logger(TopologyCorrelationService.name);
  private readonly config: TopologyCorrelationConfig;
  private readonly metrics: TopologyCorrelationMetrics;

  constructor(
    @Inject(TOPOLOGY_REPOSITORY)
    private readonly topology: TopologyRepository,
    private readonly configService: ConfigService,
    @Optional() @Inject(EVENT_BUS) private readonly eventBus?: EventBus,
    @Optional() metrics?: TopologyCorrelationMetrics,
    @Optional() platformMetrics?: MetricsService,
  ) {
    const read = (key: string) => {
      const value = this.configService.get<string>(key);
      return typeof value === 'string' ? value : undefined;
    };
    this.config = loadTopologyCorrelationConfig(read);
    this.metrics = metrics ?? new TopologyCorrelationMetrics();
    platformMetrics?.registerContributor('aiops-topology-correlation', () =>
      this.metrics.render(),
    );
  }

  async apply(
    input: TopologyCorrelationApplyInput,
  ): Promise<TopologyCorrelationApplyResult> {
    const merged = await this.mergeByRootCause(input);
    const enrichments = await Promise.all(
      merged.clusters.map((cluster, index) =>
        this.enrichCluster(
          input.tenantId,
          cluster,
          merged.flags[index],
          input.hops,
        ),
      ),
    );
    this.metrics.recordCorrelation(enrichments.length);
    if (merged.suppressions > 0) {
      this.metrics.recordSuppression(merged.suppressions);
    }
    this.logger.log(
      `aiops topology correlation tenant=${input.tenantSlug} clusters=${enrichments.length} suppressions=${merged.suppressions}`,
    );
    return {
      clusters: merged.clusters,
      enrichments,
      suppressions: merged.suppressions,
    };
  }

  attachToCorrelation(
    correlation: ClusterCorrelation,
    enrichment: TopologyClusterEnrichment,
  ): ClusterCorrelation {
    const extra: CorrelationEvidence[] = topologyEvidenceStatements({
      ancestorKey: enrichment.topologyEvidence.commonAncestorKey,
      ancestorName: enrichment.topologyEvidence.commonAncestorName,
      topologyScore: enrichment.topologyEvidence.topologyScore,
      causalScore: enrichment.topologyEvidence.causalScore,
      relationshipConfidence:
        enrichment.topologyEvidence.relationshipConfidence,
      suppressed: enrichment.suppression.independentIncidentsSuppressed,
    });
    const nodeCount = enrichment.topologyEvidence.pathScores.length > 0;
    if (!nodeCount) {
      return {
        ...correlation,
        evidence: [...correlation.evidence, ...extra.map((item) => item.statement)],
        details: [...correlation.details, ...extra],
      };
    }
    return applyTopologyComponent(
      correlation,
      enrichment.topologyEvidence.topologyScore,
      extra,
    );
  }

  async publish(input: {
    tenantId: string;
    tenantSlug: string;
    clusterKey: string;
    incidentId?: string;
    siteId?: string | null;
    enrichment: TopologyClusterEnrichment;
  }): Promise<void> {
    if (!this.eventBus) return;
    const payload: TopologyCorrelationEventPayload = {
      tenantId: input.tenantId,
      tenantSlug: input.tenantSlug,
      clusterKey: input.clusterKey,
      incidentId: input.incidentId,
      siteId: input.siteId ?? null,
      blastRadius: input.enrichment.blastRadius,
      suppression: input.enrichment.suppression,
      topologyEvidence: input.enrichment.topologyEvidence,
    };
    try {
      await this.eventBus.publish(EventSubjects.EVENTS_CORRELATED, {
        payload,
        headers: buildHeaders({
          tenantId: input.tenantId,
          siteId: input.siteId ?? undefined,
          incidentId: input.incidentId,
          correlationId: input.clusterKey,
          producedBy: 'aiops.topology-correlation',
        }),
        idempotencyKey: `${input.tenantId}:${EventSubjects.EVENTS_CORRELATED}:${input.clusterKey}`,
      });
    } catch (error) {
      const reason =
        error instanceof EventBusUnavailableError
          ? 'bus_unavailable'
          : error instanceof Error
            ? error.message
            : 'unknown';
      this.logger.warn(
        `aiops topology correlation publish skipped tenant=${input.tenantId} reason=${reason}`,
      );
    }
  }

  renderMetrics(): string {
    return this.metrics.render();
  }

  private async mergeByRootCause(input: TopologyCorrelationApplyInput): Promise<{
    clusters: TopologyAlertItem[][];
    flags: Array<{
      applied: boolean;
      suppressed: number;
      ancestorKey: string | null;
      ancestorName: string | null;
    }>;
    suppressions: number;
  }> {
    const { clusters } = input;
    const flags = clusters.map(() => ({
      applied: false,
      suppressed: 0,
      ancestorKey: null as string | null,
      ancestorName: null as string | null,
    }));
    if (!this.config.suppression.enabled || clusters.length < 2) {
      return { clusters, flags, suppressions: 0 };
    }

    const parent = clusters.map((_, index) => index);
    const find = (index: number): number => {
      let current = index;
      while (parent[current] !== current) {
        parent[current] = parent[parent[current]];
        current = parent[current];
      }
      return current;
    };
    const union = (left: number, right: number) => {
      const a = find(left);
      const b = find(right);
      if (a !== b) parent[b] = a;
    };

    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        if (
          !clusterWindowOverlap(clusters[i], clusters[j], input.windowMs)
        ) {
          continue;
        }
        const decision = await this.evaluateSuppression(
          input.tenantId,
          [...clusters[i], ...clusters[j]],
          input.hops,
        );
        if (decision.suppress) union(i, j);
      }
    }

    const groups = new Map<number, number[]>();
    for (let i = 0; i < clusters.length; i += 1) {
      const root = find(i);
      const list = groups.get(root) ?? [];
      list.push(i);
      groups.set(root, list);
    }

    const merged: TopologyAlertItem[][] = [];
    const mergedFlags: typeof flags = [];
    let suppressions = 0;
    for (const indexes of groups.values()) {
      const combined = indexes.flatMap((index) => clusters[index]);
      const suppressed = Math.max(0, indexes.length - 1);
      let ancestorKey: string | null = null;
      let ancestorName: string | null = null;
      if (suppressed > 0) {
        const decision = await this.evaluateSuppression(
          input.tenantId,
          combined,
          input.hops,
        );
        ancestorKey = decision.ancestorKey;
        ancestorName = decision.ancestorName;
        suppressions += suppressed;
      }
      merged.push(combined);
      mergedFlags.push({
        applied: suppressed > 0,
        suppressed,
        ancestorKey,
        ancestorName,
      });
    }
    return { clusters: merged, flags: mergedFlags, suppressions };
  }

  private async evaluateSuppression(
    tenantId: string,
    items: TopologyAlertItem[],
    hops: number,
  ): Promise<{
    suppress: boolean;
    ancestorKey: string | null;
    ancestorName: string | null;
    confidence: number;
    maxDistance: number | null;
  }> {
    const nodeKeys = clusterNodeKeys(items);
    const siteId = clusterSiteId(items) || undefined;
    const walkHops = Math.max(hops, this.config.suppression.maxHops);
    if (nodeKeys.length < 2) {
      return {
        suppress: false,
        ancestorKey: null,
        ancestorName: null,
        confidence: 0,
        maxDistance: null,
      };
    }
    const ancestor = await this.topology.getCommonAncestor(
      tenantId,
      nodeKeys,
      { siteId, hops: walkHops },
    );
    if (!ancestor || ancestor.tenantId !== tenantId) {
      return {
        suppress: false,
        ancestorKey: null,
        ancestorName: null,
        confidence: 0,
        maxDistance: null,
      };
    }
    const towardCause = await this.pathsToward(
      tenantId,
      nodeKeys.filter((key) => key !== ancestor.entityKey),
      ancestor.entityKey,
      siteId,
      walkHops,
    );
    const maxDistance =
      towardCause.length === 0
        ? null
        : Math.max(
            ...towardCause.map((item) => item.distance ?? Number.POSITIVE_INFINITY),
          );
    const finiteMax =
      maxDistance != null && Number.isFinite(maxDistance) ? maxDistance : null;
    const hopConfidences = towardCause.map(
      (item) => item.relationshipConfidence,
    );
    const confidence =
      hopConfidences.length === 0
        ? 0
        : aggregatePathConfidence(hopConfidences);
    const suppress = shouldSuppressIndependentIncidents({
      config: this.config.suppression,
      nodeKeys,
      ancestorKey: ancestor.entityKey,
      relationshipConfidence: confidence,
      maxDistance: finiteMax,
    });
    return {
      suppress,
      ancestorKey: ancestor.entityKey,
      ancestorName: ancestor.name,
      confidence,
      maxDistance: finiteMax,
    };
  }

  private async enrichCluster(
    tenantId: string,
    cluster: TopologyAlertItem[],
    flag: {
      applied: boolean;
      suppressed: number;
      ancestorKey: string | null;
      ancestorName: string | null;
    },
    hops: number,
  ): Promise<TopologyClusterEnrichment> {
    const nodeKeys = clusterNodeKeys(cluster);
    const siteId = clusterSiteId(cluster) || undefined;
    const walkHops = Math.max(
      hops,
      this.config.blastHops,
      this.config.suppression.maxHops,
    );
    const ancestor =
      flag.ancestorKey
        ? await this.topology.getEntity(tenantId, flag.ancestorKey)
        : nodeKeys.length > 0
          ? await this.topology.getCommonAncestor(tenantId, nodeKeys, {
              siteId,
              hops: walkHops,
            })
          : null;
    const safeAncestor =
      ancestor && ancestor.tenantId === tenantId ? ancestor : null;
    const causeKey = await this.pickCauseKey(
      tenantId,
      nodeKeys,
      safeAncestor?.entityKey ?? null,
      siteId,
      walkHops,
    );
    const causeEntity = causeKey
      ? await this.topology.getEntity(tenantId, causeKey)
      : null;
    const originKey =
      causeEntity?.entityKey ?? safeAncestor?.entityKey ?? nodeKeys[0] ?? null;
    const pathScores =
      nodeKeys.length >= 2
        ? await this.scorePairs(tenantId, nodeKeys, siteId, hops)
        : [];
    const pairTotals = scoreAlertPairTopology(pathScores);
    const topologyScore =
      nodeKeys.length < 2
        ? nodeKeys.length === 1
          ? 0.4
          : 0
        : pairTotals.topologyScore;
    const causalScore = nodeKeys.length < 2 ? 0 : pairTotals.causalScore;
    const towardOrigin = originKey
      ? await this.pathsToward(
          tenantId,
          nodeKeys.filter((key) => key !== originKey),
          originKey,
          siteId,
          walkHops,
        )
      : [];
    const relationshipConfidence =
      towardOrigin.length > 0
        ? aggregatePathConfidence(
            towardOrigin.map((item) => item.relationshipConfidence),
          )
        : pathScores.length > 0
          ? aggregatePathConfidence(
              pathScores.map((item) => item.relationshipConfidence || 0.01),
            )
          : 0;
    const blastRadius = originKey
      ? await this.computeBlastRadius(tenantId, originKey, walkHops, siteId)
      : null;
    const impactPropagation = blastRadius
      ? propagateImpact(
          blastRadius.originKey,
          [
            ...blastRadius.directDependents,
            ...blastRadius.indirectDependents,
          ],
          relationshipConfidence || 0.55,
        )
      : null;
    const displayedCause = causeEntity ?? safeAncestor;
    const suppression: RootCauseSuppression = {
      applied: flag.applied,
      enabled: this.config.suppression.enabled,
      reason: flag.applied
        ? 'ancestro común con confianza de relación suficiente; síntomas aguas abajo visibles en evidencia'
        : this.config.suppression.enabled
          ? 'sin ancestro común con confianza suficiente'
          : 'supresión desactivada',
      rootCauseKey: flag.applied ? (displayedCause?.entityKey ?? null) : null,
      rootCauseName: flag.applied ? (displayedCause?.name ?? null) : null,
      suppressedEntityKeys: flag.applied
        ? nodeKeys.filter((key) => key !== displayedCause?.entityKey)
        : [],
      evidenceRetained: true,
      independentIncidentsSuppressed: flag.suppressed,
    };
    const topologyEvidence: TopologyEvidenceSummary = {
      tenantId,
      commonAncestorKey: displayedCause?.entityKey ?? null,
      commonAncestorName: displayedCause?.name ?? null,
      topologyScore,
      causalScore,
      relationshipConfidence,
      pathScores,
      impactPropagation,
      statements: topologyEvidenceStatements({
        ancestorKey: displayedCause?.entityKey ?? null,
        ancestorName: displayedCause?.name ?? null,
        topologyScore,
        causalScore,
        relationshipConfidence,
        suppressed: flag.suppressed,
      }).map((item) => item.statement),
    };
    return {
      tenantId,
      blastRadius,
      suppression,
      topologyEvidence,
    };
  }

  private async pickCauseKey(
    tenantId: string,
    nodeKeys: string[],
    ancestorKey: string | null,
    siteId: string | undefined,
    hops: number,
  ): Promise<string | null> {
    const coveringInfra: string[] = [];
    for (const key of nodeKeys) {
      const entity = await this.topology.getEntity(tenantId, key);
      if (!entity || entity.tenantId !== tenantId) continue;
      if (!isInfraKind(entity.kind)) continue;
      const others = nodeKeys.filter((item) => item !== key);
      if (others.length === 0) {
        coveringInfra.push(key);
        continue;
      }
      const paths = await Promise.all(
        others.map((other) =>
          this.topology.getPath(tenantId, other, key, { siteId, hops }),
        ),
      );
      if (
        paths.every(
          (path) =>
            path &&
            path.length > 0 &&
            path.every((node) => node.tenantId === tenantId),
        )
      ) {
        coveringInfra.push(key);
      }
    }
    return pickRootCauseKey({ ancestorKey, coveringInfraKeys: coveringInfra });
  }

  private async scorePairs(
    tenantId: string,
    nodeKeys: string[],
    siteId: string | undefined,
    hops: number,
  ): Promise<DependencyPathScore[]> {
    const scores: DependencyPathScore[] = [];
    for (let i = 0; i < nodeKeys.length; i += 1) {
      for (let j = i + 1; j < nodeKeys.length; j += 1) {
        scores.push(
          await this.scorePair(
            tenantId,
            nodeKeys[i],
            nodeKeys[j],
            siteId,
            hops,
          ),
        );
      }
    }
    return scores;
  }

  private async scorePair(
    tenantId: string,
    fromKey: string,
    toKey: string,
    siteId: string | undefined,
    hops: number,
  ): Promise<DependencyPathScore> {
    const path = await this.topology.getPath(tenantId, fromKey, toKey, {
      siteId,
      hops,
    });
    if (!path || path.some((entity) => entity.tenantId !== tenantId)) {
      return scoreDependencyPath({
        fromKey,
        toKey,
        distance: null,
        direction: 'none',
        hops,
        relationshipConfidence: 0,
      });
    }
    const direction = await this.pathDirection(
      tenantId,
      fromKey,
      toKey,
      siteId,
      hops,
      path,
    );
    const facts = await this.factsAlongPath(tenantId, path, siteId);
    const hopScores = this.hopConfidences(path, facts);
    return scoreDependencyPath({
      fromKey,
      toKey,
      distance: Math.max(0, path.length - 1),
      direction,
      hops,
      relationshipConfidence: aggregatePathConfidence(hopScores),
    });
  }

  private async pathsToward(
    tenantId: string,
    fromKeys: string[],
    causeKey: string,
    siteId: string | undefined,
    hops: number,
  ): Promise<DependencyPathScore[]> {
    const scores: DependencyPathScore[] = [];
    for (const fromKey of fromKeys) {
      scores.push(
        await this.scorePair(tenantId, fromKey, causeKey, siteId, hops),
      );
    }
    return scores;
  }

  private async pathDirection(
    tenantId: string,
    fromKey: string,
    toKey: string,
    siteId: string | undefined,
    hops: number,
    path: TopologyEntity[],
  ): Promise<PathDirection> {
    if (fromKey === toKey) return 'undirected';
    const ancestorsOfFrom = await this.topology.getAncestors(
      tenantId,
      fromKey,
      { siteId, hops },
    );
    if (ancestorsOfFrom.some((entity) => entity.entityKey === toKey)) {
      return 'upstream';
    }
    const ancestorsOfTo = await this.topology.getAncestors(tenantId, toKey, {
      siteId,
      hops,
    });
    if (ancestorsOfTo.some((entity) => entity.entityKey === fromKey)) {
      return 'downstream';
    }
    return path.length > 0 ? 'undirected' : 'none';
  }

  private async factsAlongPath(
    tenantId: string,
    path: TopologyEntity[],
    siteId: string | undefined,
  ): Promise<RelationshipFact[]> {
    const facts: RelationshipFact[] = [];
    for (let i = 0; i < path.length - 1; i += 1) {
      const current = path[i];
      const next = path[i + 1];
      if (current.tenantId !== tenantId || next.tenantId !== tenantId) continue;
      const related = await this.topology.findRelatedEntities(
        tenantId,
        current.entityKey,
        { siteId, hops: 1 },
      );
      for (const item of related) {
        if (item.entity.tenantId !== tenantId) continue;
        if (item.entity.entityKey !== next.entityKey) continue;
        facts.push(toFact(item.relationship));
      }
    }
    return facts;
  }

  private hopConfidences(
    path: TopologyEntity[],
    facts: RelationshipFact[],
  ): number[] {
    const scores: number[] = [];
    for (let i = 0; i < path.length - 1; i += 1) {
      const fromKey = path[i].entityKey;
      const toKey = path[i + 1].entityKey;
      const hopFacts = facts.filter(
        (fact) =>
          (fact.fromKey === fromKey && fact.toKey === toKey) ||
          (fact.fromKey === toKey && fact.toKey === fromKey),
      );
      scores.push(hopFacts.length > 0 ? aggregateHopSources(hopFacts) : 0.2);
    }
    return scores;
  }

  private async computeBlastRadius(
    tenantId: string,
    originKey: string,
    hops: number,
    siteId: string | undefined,
  ): Promise<BlastRadius | null> {
    const origin = await this.topology.getEntity(tenantId, originKey);
    if (!origin || origin.tenantId !== tenantId) return null;
    const [dependents, related] = await Promise.all([
      this.topology.getDependents(tenantId, originKey, { siteId }),
      this.topology.findRelatedEntities(tenantId, originKey, {
        siteId,
        hops: 1,
      }),
    ]);
    const direct = new Map<string, BlastRadiusNode>();
    const addDirect = (entity: TopologyEntity) => {
      if (entity.tenantId !== tenantId) return;
      if (entity.entityKey === originKey) return;
      direct.set(entity.entityKey, toBlastNode(entity, 1));
    };
    for (const item of dependents) addDirect(item.entity);
    for (const item of related) addDirect(item.entity);

    const seen = new Map<string, BlastRadiusNode>(direct);
    let frontier = [...direct.keys()];
    for (let distance = 2; distance <= hops; distance += 1) {
      const following: string[] = [];
      for (const key of frontier) {
        const neighbors = await this.neighbors(tenantId, key, siteId);
        for (const entity of neighbors) {
          if (entity.tenantId !== tenantId) continue;
          if (entity.entityKey === originKey) continue;
          if (seen.has(entity.entityKey)) continue;
          seen.set(entity.entityKey, toBlastNode(entity, distance));
          following.push(entity.entityKey);
        }
      }
      frontier = following;
    }
    const indirect = [...seen.values()].filter(
      (node) => !direct.has(node.entityKey),
    );
    return buildBlastRadius({
      originKey,
      hops,
      direct: [...direct.values()],
      indirect,
    });
  }

  private async neighbors(
    tenantId: string,
    entityKey: string,
    siteId: string | undefined,
  ): Promise<TopologyEntity[]> {
    const [dependents, related] = await Promise.all([
      this.topology.getDependents(tenantId, entityKey, { siteId }),
      this.topology.findRelatedEntities(tenantId, entityKey, {
        siteId,
        hops: 1,
      }),
    ]);
    const byKey = new Map<string, TopologyEntity>();
    for (const item of [...dependents, ...related] as RelatedEntity[]) {
      if (item.entity.tenantId !== tenantId) continue;
      byKey.set(item.entity.entityKey, item.entity);
    }
    return [...byKey.values()];
  }
}

function toFact(relationship: TopologyRelationship): RelationshipFact {
  return {
    fromKey: relationship.fromKey,
    toKey: relationship.toKey,
    relation: relationship.relation,
    source: relationship.source,
    confidence: relationship.confidence,
  };
}
