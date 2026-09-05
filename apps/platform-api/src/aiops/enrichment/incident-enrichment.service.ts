import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MetricsService } from '../../observability/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GraphService } from '../graph.service';
import { assertTenantScope, TenantScopeError } from '../persistence/tenant-scope.error';
import {
  ANOMALY_REPOSITORY,
  type AnomalyRepository,
} from '../anomaly/anomaly.repository';
import type { AnomalyResult } from '../anomaly/anomaly-result';
import { HistoricalService } from '../historical/historical.service';
import { RCA_ALGORITHM } from '../rca/constants';
import type { RcaCompletedPayload } from '../rca/types';
import {
  INCIDENT_ENRICHMENT_REPOSITORY,
  type IncidentEnrichmentRepository,
} from './incident-enrichment.repository';
import { IncidentEnrichmentMetrics } from './incident-enrichment.metrics';
import {
  IncidentPriorityCalculator,
  type TenantPriorityPolicy,
} from './incident-priority.calculator';
import { orderTimeline, timelineEntry } from './incident-timeline';
import {
  INCIDENT_ENRICHMENT_ALGORITHM,
  INCIDENT_ENRICHMENT_SCHEMA_VERSION,
  INCIDENT_ENRICHMENT_SOURCE,
  RCA_ENGINE_ALGORITHM,
  RCA_ENGINE_SOURCE,
  clampUnit,
  parseRcaFeedbackAction,
  type CorrelationEvidenceItem,
  type EnrichedEntity,
  type EnrichmentEvidence,
  type HistoricalMatch,
  type IncidentAnomaly,
  type IncidentEnrichment,
  type IncidentMembersView,
  type RcaFeedbackInput,
  type RecentChange,
  type RootCauseCandidateView,
} from './incident-enrichment.types';

type IncidentRow = {
  id: string;
  tenantId: string;
  title: string;
  status: string;
  severity: string;
  siteId: string | null;
  clusterKey: string | null;
  causeKey: string | null;
  causeName: string | null;
  confidence: number | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  members: unknown;
  createdAt: Date;
  updatedAt: Date;
};

const SERVICE_KINDS = new Set([
  'service',
  'database',
  'db',
  'deployment',
  'statefulset',
  'pod',
]);

const CHANGE_CATEGORIES = new Set(['change', 'deploy', 'deployment']);

@Injectable()
export class IncidentEnrichmentService {
  private readonly logger = new Logger(IncidentEnrichmentService.name);
  private readonly calculator: IncidentPriorityCalculator;
  private readonly metrics: IncidentEnrichmentMetrics;

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    @Inject(INCIDENT_ENRICHMENT_REPOSITORY)
    private readonly store: IncidentEnrichmentRepository,
    calculator?: IncidentPriorityCalculator,
    @Optional() metrics?: IncidentEnrichmentMetrics,
    @Optional() platformMetrics?: MetricsService,
    @Optional() @Inject(ANOMALY_REPOSITORY)
    private readonly anomalies?: AnomalyRepository,
    @Optional() private readonly historical?: HistoricalService,
  ) {
    this.calculator = calculator ?? new IncidentPriorityCalculator();
    this.metrics = metrics ?? new IncidentEnrichmentMetrics();
    platformMetrics?.registerContributor('aiops-incident-enrichment', () =>
      this.metrics.render(),
    );
  }

  renderMetrics(): string {
    return this.metrics.render();
  }

  async find(
    tenantId: string,
    incidentId: string,
  ): Promise<IncidentEnrichment | null> {
    assertTenantScope(tenantId);
    const row = await this.store.findByIncident(tenantId, incidentId);
    if (row && row.tenantId !== tenantId) {
      throw new TenantScopeError();
    }
    return row;
  }

  async attachMany<T extends { id: string; tenantId: string }>(
    tenantId: string,
    incidents: T[],
  ): Promise<Array<T & { enrichment: IncidentEnrichment | null }>> {
    assertTenantScope(tenantId);
    const byId = await this.store.findByIncidentIds(
      tenantId,
      incidents.map((item) => item.id),
    );
    return incidents.map((item) => {
      if (item.tenantId !== tenantId) {
        return { ...item, enrichment: null };
      }
      return { ...item, enrichment: byId.get(item.id) ?? null };
    });
  }

  async enrich(tenantId: string, incidentId: string): Promise<IncidentEnrichment | null> {
    const started = process.hrtime.bigint();
    try {
      assertTenantScope(tenantId);
      const incident = await this.prisma.incident.findFirst({
        where: { id: incidentId, tenantId },
      });
      if (!incident || incident.tenantId !== tenantId) {
        this.metrics.record(elapsed(started), 'missing');
        this.logger.log(
          `aiops incident enrichment skipped missing tenantId=${tenantId} incidentId=${incidentId}`,
        );
        return null;
      }
      const previous = await this.store.findByIncident(tenantId, incidentId);
      const built = await this.build(incident as IncidentRow, previous);
      const saved = await this.store.save(built);
      this.metrics.record(elapsed(started), 'ok');
      this.metrics.recordUpdate();
      this.logger.log(
        `aiops incident enrichment completed tenantId=${tenantId} incidentId=${incidentId} duration_s=${elapsed(started).toFixed(3)} priority=${saved.computedPriority.level}`,
      );
      return saved;
    } catch (error) {
      this.metrics.record(elapsed(started), 'error');
      throw error;
    }
  }

  async applyRcaFeedback(
    tenantId: string,
    incidentId: string,
    input: RcaFeedbackInput,
  ): Promise<IncidentEnrichment> {
    assertTenantScope(tenantId);
    const action = parseRcaFeedbackAction(input.action);
    if (!action) {
      throw new Error('Accion de feedback RCA no soportada.');
    }
    const current = await this.store.findByIncident(tenantId, incidentId);
    if (!current || current.tenantId !== tenantId) {
      throw new Error('Sin enriquecimiento para este incidente.');
    }
    const now = new Date().toISOString();
    const candidates = applyCandidateAction(current.rootCauseCandidates, {
      ...input,
      action,
    });
    const primary =
      candidates.find((item) => item.status === 'ACCEPTED') ??
      candidates.find((item) => item.rank === 1) ??
      null;
    const next: IncidentEnrichment = {
      ...current,
      rootCauseCandidates: candidates,
      primaryRootCause: primary,
      rcaConfidence: primary?.confidence ?? current.rcaConfidence,
      operatorFeedback: [
        ...current.operatorFeedback,
        {
          action,
          candidateId: input.candidateId,
          note: input.note?.trim() || undefined,
          actor: input.actor,
          at: now,
          source: 'operator',
          algorithm: 'rca_operator_feedback',
        },
      ],
    };
    const saved = await this.store.save(next);
    this.metrics.recordUpdate();
    return saved;
  }

  async applyRcaCompleted(
    tenantId: string,
    incidentId: string,
    payload: RcaCompletedPayload,
  ): Promise<IncidentEnrichment | null> {
    assertTenantScope(tenantId);
    if (payload.tenantId !== tenantId) {
      throw new TenantScopeError();
    }
    let current = await this.store.findByIncident(tenantId, incidentId);
    if (!current) {
      current = await this.enrich(tenantId, incidentId);
    }
    if (!current || current.tenantId !== tenantId) {
      return null;
    }
    const candidates = (payload.candidates ?? []).map((item, index) =>
      fromCompletedCandidate(tenantId, incidentId, item, index),
    );
    if (candidates.length === 0) {
      return current;
    }
    const primary = candidates.find((item) => item.rank === 1) ?? candidates[0];
    const next: IncidentEnrichment = {
      ...current,
      rootCauseCandidates: candidates,
      primaryRootCause: primary,
      rcaConfidence: payload.leadingConfidence ?? primary.confidence,
      rcaMode: 'deterministic_engine',
      evidence: [
        {
          kind: 'rca',
          statement: primary.hypothesis,
          score: primary.score,
          confidence: primary.confidence,
          algorithm: RCA_ENGINE_ALGORITHM,
          source: RCA_ENGINE_SOURCE,
        },
        ...current.evidence.filter((item) => item.kind !== 'rca'),
      ],
    };
    const saved = await this.store.save(next);
    this.metrics.recordUpdate();
    this.metrics.recordRcaPersisted();
    this.logger.log(
      `aiops incident rca.completed persisted tenantId=${tenantId} incidentId=${incidentId} candidates=${candidates.length}`,
    );
    return saved;
  }

  async applyInvestigationCompleted(
    tenantId: string,
    incidentId: string,
    input: {
      investigationId: string;
      version: number;
      status: string;
      confidence: number;
      summary: string;
    },
  ): Promise<IncidentEnrichment | null> {
    assertTenantScope(tenantId);
    const current = await this.store.findByIncident(tenantId, incidentId);
    if (!current || current.tenantId !== tenantId) {
      return null;
    }
    const aiStatus = toAiInvestigationStatus(input.status);
    const next: IncidentEnrichment = {
      ...current,
      aiInvestigationStatus: aiStatus,
      investigationId: input.investigationId,
      investigationVersion: input.version,
      investigationConfidence: input.confidence,
      synthesisSummary: input.summary,
    };
    const saved = await this.store.save(next);
    this.metrics.recordUpdate();
    return saved;
  }

  private async build(
    incident: IncidentRow,
    previous: IncidentEnrichment | null,
  ): Promise<IncidentEnrichment> {
    const members = parseMembers(incident.members);
    const originKey = incident.causeKey || members.impact[0] || null;
    const impact = originKey
      ? await this.graph.impact(incident.tenantId, originKey)
      : { origin: null, hops: 3, nodes: [], edges: [] as Array<{ from: string; to: string }> };
    const nodeByKey = new Map(
      (impact.nodes ?? []).map((node) => [node.key, node]),
    );
    const blastKeys = [
      ...new Set(
        [
          originKey,
          ...members.impact,
          ...members.alerts.map((alert) => alert.nodeHint),
          ...(impact.nodes ?? []).map((node) => node.key),
        ].filter((key): key is string => Boolean(key)),
      ),
    ];
    const extraNodes = await this.loadNamedNodes(incident.tenantId, blastKeys);
    for (const node of extraNodes) {
      if (!nodeByKey.has(node.key)) nodeByKey.set(node.key, node);
    }

    const affectedEntities = this.toEntities(
      incident,
      members,
      blastKeys,
      nodeByKey,
      originKey,
    );
    const affectedServices = affectedEntities.filter((item) =>
      SERVICE_KINDS.has(item.kind.toLowerCase()),
    );
    const blastScore = clampUnit(blastKeys.length / 10);
    const blastEvidence: EnrichmentEvidence[] = [
      {
        kind: 'topology',
        statement: originKey
          ? `radio de impacto desde ${originKey} hops=${impact.hops}`
          : 'sin origen de grafo; radio derivado de miembros',
        score: blastScore,
        confidence: originKey ? 0.75 : 0.4,
        algorithm: 'graph_impact_walk',
        source: 'graph.impact',
        details: { hops: impact.hops, entityCount: blastKeys.length },
      },
    ];
    const topologyEvidence: EnrichmentEvidence[] = [
      ...blastEvidence,
      ...(impact.edges ?? []).slice(0, 24).map((edge) => ({
        kind: 'topology',
        statement: `${edge.from} -> ${edge.to}`,
        score: 0.55,
        confidence: 0.7,
        algorithm: 'graph_impact_walk',
        source: 'graph.impact',
        details: { from: edge.from, to: edge.to },
      })),
    ];
    const anomalies = await this.loadAnomalies(incident, members, blastKeys);
    const correlationEvidence = correlationItems(members);
    const engineRca = (previous?.rootCauseCandidates ?? []).filter(
      (item) => item.algorithm === RCA_ENGINE_ALGORITHM,
    );
    const rootCauseCandidates =
      engineRca.length > 0
        ? engineRca
        : buildCandidates(incident, members, nodeByKey);
    const rcaMode: IncidentEnrichment['rcaMode'] =
      engineRca.length > 0 ? 'deterministic_engine' : 'correlation_fallback';
    const primary =
      rootCauseCandidates.find((item) => item.rank === 1) ?? null;
    const rcaConfidence = primary?.confidence ?? incident.confidence;
    const recentChanges = await this.loadRecentChanges(incident);
    const historicalMatches = await this.loadHistorical(incident, members, anomalies);
    await this.recordHistoricalSignature(
      incident,
      members,
      anomalies,
      blastKeys,
    );
    const environment = await this.resolveEnvironment(incident, members);
    const policy = await this.loadPriorityPolicy(incident.tenantId);
    const computedPriority = this.calculator.calculate({
      severity: incident.severity,
      environment,
      blastRadiusEntityCount: blastKeys.length,
      affectedEntityCount: affectedEntities.length,
      serviceKinds: affectedServices.map((item) => item.kind),
      tenantPolicy: policy,
    });
    const timeline = orderTimeline([
      ...anomalies.map((item) =>
        timelineEntry({
          occurredAt: item.occurredAt,
          summary: item.summary,
          kind: item.kind === 'error' ? 'error' : 'anomaly',
          entityKey: item.entityKey,
          source: item.source,
          score: item.score,
          confidence: item.confidence,
          evidence: item.evidence,
        }),
      ),
      ...recentChanges.map((item) =>
        timelineEntry({
          occurredAt: item.occurredAt,
          summary: item.summary,
          kind: 'change',
          entityKey: item.entityKey,
          source: item.source,
          score: item.score,
          confidence: item.confidence,
          evidence: item.evidence,
        }),
      ),
    ]);

    const score = clampUnit(
      (computedPriority.score + (rcaConfidence ?? 0.4) + blastScore) / 3,
    );

    return {
      tenantId: incident.tenantId,
      incidentId: incident.id,
      schemaVersion: INCIDENT_ENRICHMENT_SCHEMA_VERSION,
      algorithm: INCIDENT_ENRICHMENT_ALGORITHM,
      source: INCIDENT_ENRICHMENT_SOURCE,
      score,
      confidence: clampUnit(rcaConfidence ?? computedPriority.confidence),
      evidence: [
        {
          kind: 'enrichment',
          statement: 'enriquecimiento determinista sin LLM',
          score,
          confidence: clampUnit(rcaConfidence ?? 0.4),
          algorithm: INCIDENT_ENRICHMENT_ALGORITHM,
          source: INCIDENT_ENRICHMENT_SOURCE,
        },
        ...correlationEvidence.slice(0, 8),
      ],
      computedPriority,
      affectedEntities,
      affectedServices,
      blastRadius: {
        originKey,
        hops: impact.hops ?? 3,
        entityCount: blastKeys.length,
        entityKeys: blastKeys,
        score: blastScore,
        confidence: originKey ? 0.75 : 0.4,
        algorithm: 'graph_impact_walk',
        source: 'graph.impact',
        evidence: blastEvidence,
      },
      topologyEvidence,
      anomalies,
      rootCauseCandidates,
      primaryRootCause: primary,
      rcaConfidence,
      correlationEvidence,
      timeline,
      recentChanges,
      historicalMatches,
      operatorFeedback: previous?.operatorFeedback ?? [],
      rcaMode,
      aiInvestigationStatus: 'not_executed',
      enrichedAt: new Date().toISOString(),
    };
  }

  private toEntities(
    incident: IncidentRow,
    members: IncidentMembersView,
    keys: string[],
    nodeByKey: Map<string, { key: string; name: string; kind: string }>,
    originKey: string | null,
  ): EnrichedEntity[] {
    const alertHints = new Set(
      members.alerts.map((alert) => alert.nodeHint).filter(Boolean),
    );
    const impact = new Set(members.impact);
    return keys.map((entityKey) => {
      const node = nodeByKey.get(entityKey);
      const kind = node?.kind || inferKind(entityKey);
      const role =
        entityKey === originKey
          ? 'cause'
          : SERVICE_KINDS.has(kind.toLowerCase())
            ? 'service'
            : impact.has(entityKey)
              ? 'impact'
              : alertHints.has(entityKey)
                ? 'alert'
                : 'neighbor';
      const score =
        role === 'cause' ? 0.9 : role === 'service' ? 0.7 : role === 'impact' ? 0.6 : 0.45;
      return {
        entityKey,
        name: node?.name || entityKey,
        kind,
        role,
        score,
        confidence: node ? 0.8 : 0.45,
        algorithm: 'member_topology_union',
        source: 'incident.members+graph',
        evidence: [
          {
            kind: 'entity',
            statement: `${entityKey} rol=${role}`,
            score,
            confidence: node ? 0.8 : 0.45,
            algorithm: 'member_topology_union',
            source: 'incident.members+graph',
            details: { incidentId: incident.id, kind },
          },
        ],
      };
    });
  }

  private async loadNamedNodes(tenantId: string, keys: string[]) {
    if (keys.length === 0) return [];
    const rows = await this.graph.listNodes(tenantId, { keys });
    return rows.map((row) => ({
      key: row.nodeKey,
      name: row.name,
      kind: row.kind,
      siteId: row.siteId,
    }));
  }

  private async loadRecentChanges(incident: IncidentRow): Promise<RecentChange[]> {
    const from = incident.windowStart
      ? new Date(incident.windowStart.getTime() - 60 * 60_000)
      : new Date(incident.createdAt.getTime() - 60 * 60_000);
    const to = incident.windowEnd ?? incident.updatedAt;
    const rows = await this.prisma.agentEvent.findMany({
      where: {
        tenantId: incident.tenantId,
        eventAt: { gte: from, lte: to },
        ...(incident.siteId ? { siteId: incident.siteId } : {}),
      },
      orderBy: { eventAt: 'asc' },
      take: 40,
      select: {
        fingerprint: true,
        signal: true,
        category: true,
        assetKey: true,
        eventAt: true,
      },
    });
    return rows
      .filter((row) => isChangeEvent(row.category, row.signal))
      .slice(0, 20)
      .map((row) => ({
        occurredAt: row.eventAt.toISOString(),
        summary: row.signal,
        entityKey: row.assetKey ?? undefined,
        fingerprint: row.fingerprint,
        score: 0.55,
        confidence: 0.65,
        algorithm: 'collector_change_events',
        source: 'agent_event',
        evidence: [
          {
            kind: 'change',
            statement: row.signal,
            score: 0.55,
            confidence: 0.65,
            algorithm: 'collector_change_events',
            source: 'agent_event',
            details: { fingerprint: row.fingerprint },
          },
        ],
      }));
  }

  private async loadAnomalies(
    incident: IncidentRow,
    members: IncidentMembersView,
    entityKeys: string[],
  ): Promise<IncidentAnomaly[]> {
    const heuristic = classifyAnomalies(incident, members);
    if (!this.anomalies || entityKeys.length === 0) return heuristic;
    try {
      const rows = await this.anomalies.findForEntities(
        incident.tenantId,
        entityKeys,
        { windowStart: incident.windowStart, windowEnd: incident.windowEnd },
      );
      const persisted = rows
        .filter((row) => row.tenantId === incident.tenantId)
        .map((row) => fromEngineAnomaly(row));
      if (persisted.length === 0) return heuristic;
      const seen = new Set(persisted.map((item) => item.id));
      return [
        ...persisted,
        ...heuristic.filter((item) => !seen.has(item.id)),
      ];
    } catch (error) {
      this.logger.warn(
        `aiops incident enrichment anomalies failed tenantId=${incident.tenantId} incidentId=${incident.id} error=${error instanceof Error ? error.message : 'unknown'}`,
      );
      return heuristic;
    }
  }

  private async recordHistoricalSignature(
    incident: IncidentRow,
    members: IncidentMembersView,
    anomalies: IncidentAnomaly[],
    entityKeys: string[],
  ): Promise<void> {
    if (!this.historical) return;
    try {
      await this.historical.recordSignature(
        incident.tenantId,
        {
          tenantId: incident.tenantId,
          incidentId: incident.id,
          entityTypes: entityKeys.map((key) => inferKind(key)),
          serviceKey:
            members.alerts[0]?.name ?? incident.causeKey ?? undefined,
          eventTypes: [
            ...members.alerts.map((item) => item.name),
            ...members.collectorEvents.map((item) => item.signal),
          ],
          anomalyTypes: anomalies.map((item) => item.kind),
          topologyPattern: incident.causeKey ?? undefined,
          environment: incident.siteId ?? undefined,
        },
        incident.id,
      );
    } catch (error) {
      this.logger.warn(
        `aiops incident enrichment signature skipped tenantId=${incident.tenantId} incidentId=${incident.id} error=${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  private async loadHistorical(
    incident: IncidentRow,
    members: IncidentMembersView,
    anomalies: IncidentAnomaly[],
  ): Promise<HistoricalMatch[]> {
    if (this.historical) {
      try {
        const contribution = await this.historical.lookup(incident.tenantId, {
          tenantId: incident.tenantId,
          incidentId: incident.id,
          entityTypes: members.impact.map((key) => inferKind(key)),
          service: incident.causeName ?? undefined,
          eventTypes: members.alerts.map((item) => item.name),
          anomalyTypes: anomalies.map((item) => item.kind),
          topologyPattern: incident.causeKey ?? undefined,
          environment: incident.siteId ?? undefined,
          proposedRootCause: incident.causeKey ?? undefined,
        });
        if (contribution.matches.length > 0) {
          return contribution.matches.map((match) => ({
            incidentId: match.incidentId,
            title: match.confirmedRootCause ?? match.incidentId,
            causeKey: match.confirmedRootCause,
            score: match.similarity,
            confidence: match.confidence,
            algorithm: match.algorithm,
            source: match.source,
            evidence: match.evidence.map((item) => ({
              kind: 'historical',
              statement: item.summary,
              score: item.score,
              confidence: item.confidence,
              algorithm: item.algorithm,
              source: item.source,
            })),
          }));
        }
      } catch (error) {
        this.logger.warn(
          `aiops incident enrichment historical failed tenantId=${incident.tenantId} incidentId=${incident.id} error=${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }
    return this.loadCauseClusterHistory(incident);
  }

  private async loadCauseClusterHistory(incident: IncidentRow): Promise<HistoricalMatch[]> {
    const or = [
      incident.clusterKey ? { clusterKey: incident.clusterKey } : null,
      incident.causeKey ? { causeKey: incident.causeKey } : null,
    ].filter((item): item is { clusterKey: string } | { causeKey: string } =>
      Boolean(item),
    );
    if (or.length === 0) return [];
    const rows = await this.prisma.incident.findMany({
      where: {
        tenantId: incident.tenantId,
        id: { not: incident.id },
        OR: or,
      },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        title: true,
        causeKey: true,
        clusterKey: true,
        status: true,
      },
    });
    return rows.map((row, index) => ({
      incidentId: row.id,
      title: row.title,
      causeKey: row.causeKey,
      clusterKey: row.clusterKey,
      status: row.status,
      score: clampUnit(0.7 - index * 0.05),
      confidence: 0.6,
      algorithm: 'historical_cause_cluster',
      source: 'incident.history',
      evidence: [
        {
          kind: 'historical',
          statement: `incidente previo ${row.id}`,
          score: clampUnit(0.7 - index * 0.05),
          confidence: 0.6,
          algorithm: 'historical_cause_cluster',
          source: 'incident.history',
          details: {
            cluster: row.clusterKey === incident.clusterKey,
            cause: row.causeKey === incident.causeKey,
          },
        },
      ],
    }));
  }

  private async resolveEnvironment(
    incident: IncidentRow,
    members: IncidentMembersView,
  ): Promise<string | null> {
    const fps = members.collectorEvents.map((item) => item.fingerprint);
    if (fps.length === 0) return null;
    const row = await this.prisma.agentEvent.findFirst({
      where: {
        tenantId: incident.tenantId,
        fingerprint: { in: fps },
        environment: { not: null },
      },
      select: { environment: true },
    });
    return row?.environment ?? null;
  }

  private async loadPriorityPolicy(
    tenantId: string,
  ): Promise<TenantPriorityPolicy | null> {
    const row = await this.prisma.policy.findFirst({
      where: {
        tenantId,
        OR: [{ kind: 'aiops.priority' }, { name: 'incident-priority' }],
      },
      select: { payload: true },
    });
    if (!row?.payload || typeof row.payload !== 'object') return null;
    return row.payload as TenantPriorityPolicy;
  }
}

function elapsed(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e9;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function inferKind(entityKey: string): string {
  const lower = entityKey.toLowerCase();
  if (lower.includes('postgres') || lower.includes('mysql') || lower.includes('db')) {
    return 'database';
  }
  if (lower.includes('api') || lower.includes('svc') || lower.includes('service')) {
    return 'service';
  }
  if (lower.includes('pod')) return 'pod';
  if (lower.includes('sw-') || lower.includes('switch')) return 'switch';
  return 'device';
}

function isChangeEvent(category: string | null, signal: string): boolean {
  const cat = (category ?? '').toLowerCase();
  if (CHANGE_CATEGORIES.has(cat)) return true;
  return (
    signal.startsWith('change.') ||
    signal.startsWith('deploy.') ||
    signal === 'change.detected' ||
    signal === 'deploy.observed'
  );
}

function parseMembers(raw: unknown): IncidentMembersView {
  if (!raw || typeof raw !== 'object') {
    return { alerts: [], impact: [], collectorEvents: [] };
  }
  const members = raw as Record<string, unknown>;
  const alertsRaw = Array.isArray(members.alerts) ? members.alerts : [];
  const impactRaw = Array.isArray(members.impact) ? members.impact : [];
  const collectorRaw = Array.isArray(members.collectorEvents)
    ? members.collectorEvents
    : [];
  const correlation =
    members.correlation && typeof members.correlation === 'object'
      ? (members.correlation as IncidentMembersView['correlation'])
      : undefined;
  return {
    alerts: alertsRaw.map((item) => {
      const alert = (item ?? {}) as Record<string, unknown>;
      return {
        fingerprint: String(alert.fingerprint ?? ''),
        name: String(alert.name ?? alert.fingerprint ?? 'alerta'),
        severity: String(alert.severity ?? 'warning'),
        nodeHint:
          typeof alert.nodeHint === 'string' && alert.nodeHint
            ? alert.nodeHint
            : null,
        startsAt: typeof alert.startsAt === 'string' ? alert.startsAt : null,
      };
    }),
    impact: impactRaw.filter((item): item is string => typeof item === 'string'),
    correlation,
    collectorEvents: collectorRaw.map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      return {
        fingerprint: String(row.fingerprint ?? ''),
        signal: String(row.signal ?? ''),
        assetKey: typeof row.assetKey === 'string' ? row.assetKey : null,
      };
    }),
  };
}

function correlationItems(members: IncidentMembersView): CorrelationEvidenceItem[] {
  const details = members.correlation?.details ?? [];
  if (details.length > 0) {
    return details.map((item) => ({
      kind: item.kind || 'correlation',
      statement: item.statement,
      score: clampUnit(item.score),
      confidence: 0.75,
      algorithm: 'correlation_v2_members',
      source: 'incident.members.correlation',
      details: item.details,
    }));
  }
  return (members.correlation?.evidence ?? []).map((statement) => ({
    kind: 'correlation',
    statement,
    score: clampUnit(members.correlation?.score ?? 0.5),
    confidence: 0.7,
    algorithm: 'correlation_v2_members',
    source: 'incident.members.correlation',
  }));
}

function classifyAnomalies(
  incident: IncidentRow,
  members: IncidentMembersView,
): IncidentAnomaly[] {
  const items: IncidentAnomaly[] = [];
  for (const alert of members.alerts) {
    const kind = anomalyKind(`${alert.name} ${alert.fingerprint}`);
    if (kind === 'other' && alert.severity !== 'critical') continue;
    const occurredAt =
      alert.startsAt || toIso(incident.windowStart) || incident.createdAt.toISOString();
    items.push({
      id: `anom-${alert.fingerprint || alert.name}`,
      occurredAt,
      summary: humanAnomalySummary(alert.name, kind),
      entityKey: alert.nodeHint ?? undefined,
      kind,
      score: alert.severity === 'critical' ? 0.9 : 0.7,
      confidence: 0.65,
      algorithm: 'alert_name_classifier',
      source: 'incident.members.alerts',
      evidence: [
        {
          kind: 'anomaly',
          statement: alert.name,
          score: 0.7,
          confidence: 0.65,
          algorithm: 'alert_name_classifier',
          source: 'incident.members.alerts',
        },
      ],
    });
  }
  for (const event of members.collectorEvents) {
    if (event.signal !== 'metric.anomaly' && !event.signal.includes('anomaly')) {
      continue;
    }
    items.push({
      id: `anom-col-${event.fingerprint}`,
      occurredAt: toIso(incident.windowStart) || incident.createdAt.toISOString(),
      summary: event.signal,
      entityKey: event.assetKey ?? undefined,
      kind: 'metric',
      score: 0.75,
      confidence: 0.7,
      algorithm: 'alert_name_classifier',
      source: 'agent_event',
      evidence: [
        {
          kind: 'anomaly',
          statement: event.signal,
          score: 0.75,
          confidence: 0.7,
          algorithm: 'alert_name_classifier',
          source: 'agent_event',
        },
      ],
    });
  }
  return items;
}

function anomalyKind(text: string): IncidentAnomaly['kind'] {
  const lower = text.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  if (lower.includes('5xx') || lower.includes('error') || lower.includes('exception')) {
    return 'error';
  }
  if (
    lower.includes('pool') ||
    lower.includes('satura') ||
    lower.includes('cpu') ||
    lower.includes('memory')
  ) {
    return 'saturation';
  }
  if (lower.includes('latency') || lower.includes('latencia') || lower.includes('slow')) {
    return 'latency';
  }
  if (lower.includes('anomaly')) return 'metric';
  return 'other';
}

function humanAnomalySummary(name: string, kind: IncidentAnomaly['kind']): string {
  const lower = name.toLowerCase();
  if (lower.includes('db') && kind === 'latency') return 'DB latency anomaly';
  if (lower.includes('pool') || lower.includes('satura')) {
    return 'connection pool saturation';
  }
  if (lower.includes('api') && kind === 'latency') return 'API latency';
  if (lower.includes('5xx')) return 'HTTP 5xx';
  if (lower.includes('pod') && kind === 'timeout') return 'pod timeout';
  return name;
}

function buildCandidates(
  incident: IncidentRow,
  members: IncidentMembersView,
  nodeByKey: Map<string, { key: string; name: string; kind: string }>,
): RootCauseCandidateView[] {
  const candidates: RootCauseCandidateView[] = [];
  if (incident.causeKey) {
    const node = nodeByKey.get(incident.causeKey);
    const confidence = clampUnit(incident.confidence ?? 0.7);
    candidates.push({
      id: `rcc-${incident.id}-1`,
      tenantId: incident.tenantId,
      incidentId: incident.id,
      rank: 1,
      entityKey: incident.causeKey,
      hypothesis: incident.causeName || node?.name || incident.causeKey,
      confidence,
      score: confidence,
      status: 'PROPOSED',
      source: 'deterministic_rca',
      algorithm: 'common_cover_cache',
      evidence: [
        {
          kind: 'topology',
          statement: `causa preliminar del grafo: ${incident.causeKey}`,
          score: confidence,
          confidence,
          algorithm: 'common_cover_cache',
          source: 'incident.causeKey',
        },
      ],
    });
  }
  const altKeys = members.impact.filter((key) => key !== incident.causeKey);
  altKeys.slice(0, 4).forEach((entityKey, index) => {
    const rank = candidates.length + 1;
    const confidence = clampUnit(0.45 - index * 0.06);
    const node = nodeByKey.get(entityKey);
    candidates.push({
      id: `rcc-${incident.id}-${rank}`,
      tenantId: incident.tenantId,
      incidentId: incident.id,
      rank,
      entityKey,
      hypothesis: node?.name || entityKey,
      confidence,
      score: confidence,
      status: 'PROPOSED',
      source: 'deterministic_rca',
      algorithm: 'blast_radius_alternative',
      evidence: [
        {
          kind: 'topology',
          statement: `alternativa en radio de impacto: ${entityKey}`,
          score: confidence,
          confidence,
          algorithm: 'blast_radius_alternative',
          source: 'incident.members.impact',
        },
      ],
    });
  });
  return candidates;
}

function applyCandidateAction(
  candidates: RootCauseCandidateView[],
  input: RcaFeedbackInput,
): RootCauseCandidateView[] {
  const action = parseRcaFeedbackAction(input.action);
  if (!action || action === 'ADD_NOTE') return candidates;
  const targetId = input.candidateId || candidates.find((item) => item.rank === 1)?.id;
  if (!targetId) return candidates;
  if (action === 'REJECT') {
    return candidates.map((item) =>
      item.id === targetId ? { ...item, status: 'REJECTED' } : item,
    );
  }
  return candidates.map((item) => {
    if (item.id === targetId) {
      return { ...item, status: 'ACCEPTED' };
    }
    if (item.status === 'ACCEPTED' || item.status === 'PROPOSED') {
      return { ...item, status: 'SUPERSEDED' };
    }
    return item;
  });
}

function fromEngineAnomaly(row: AnomalyResult): IncidentAnomaly {
  return {
    id: row.id,
    occurredAt: row.timestamp,
    summary: row.metadata.evidence[0]?.summary ?? `${row.metricName} ${row.algorithm}`,
    entityKey: row.entityId,
    kind: anomalyKind(`${row.metricName} ${row.algorithm}`),
    score: row.score,
    confidence: row.confidence,
    algorithm: row.algorithm,
    source: 'AiopsAnomaly',
    evidence: row.metadata.evidence.map((item) => ({
      kind: 'anomaly',
      statement: item.summary,
      score: row.score,
      confidence: row.confidence,
      algorithm: row.algorithm,
      source: 'AiopsAnomaly',
    })),
  };
}

function fromCompletedCandidate(
  tenantId: string,
  incidentId: string,
  item: RcaCompletedPayload['candidates'][number],
  index: number,
): RootCauseCandidateView {
  return {
    id: `rcc-${incidentId}-${item.entityId || index + 1}`,
    tenantId,
    incidentId,
    rank: item.rank || index + 1,
    entityKey: item.entityKey ?? item.entityId,
    hypothesis: item.hypothesis,
    confidence: item.confidence,
    score: item.score,
    status: 'PROPOSED',
    source: RCA_ENGINE_SOURCE,
    algorithm: item.algorithm || RCA_ENGINE_ALGORITHM,
    evidence: item.evidence.map((ev) => ({
      kind: ev.kind,
      statement: ev.summary,
      score: item.score,
      confidence: ev.confidence ?? item.confidence,
      algorithm: item.algorithm || RCA_ALGORITHM,
      source: RCA_ENGINE_SOURCE,
      details: undefined,
    })),
  };
}

function toAiInvestigationStatus(
  status: string,
): IncidentEnrichment['aiInvestigationStatus'] {
  if (status === 'QUEUED' || status === 'PENDING') return 'PENDING';
  if (status === 'SYNTHESIZING' || status === 'RUNNING') return 'RUNNING';
  if (status === 'PARTIAL') return 'PARTIAL';
  if (status === 'COMPLETED') return 'COMPLETED';
  if (status === 'TIMEOUT') return 'TIMEOUT';
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status === 'FAILED' || status === 'BUDGET_EXCEEDED') return 'FAILED';
  return 'RUNNING';
}
