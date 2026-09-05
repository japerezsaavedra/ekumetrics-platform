import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MetricsService } from '../../observability/metrics.service';
import type { RcaEngine, RcaProposeInput } from '../interfaces/rca-engine';
import {
  TOPOLOGY_REPOSITORY,
  type TopologyRepository,
} from '../topology.repository';
import {
  createScoredRootCauseCandidate,
  type RootCauseCandidate,
} from '../types/root-cause-candidate';
import {
  ANOMALY_EVIDENCE_PORT,
  type AnomalyEvidencePort,
} from './anomaly-evidence.port';
import { NEUTRAL_HISTORICAL_SCORE, RCA_ALGORITHM, RCA_SOURCE } from './constants';
import {
  HISTORICAL_EVIDENCE_PORT,
  type HistoricalEvidencePort,
} from './historical-evidence.port';
import {
  RCA_INCIDENT_SOURCE,
  type RcaIncidentSource,
} from './incident-source';
import { RcaMetrics } from './metrics';
import { RCA_SCORING_POLICY, RcaScoringPolicyLoader, normalizeRcaWeights } from './scoring-policy';
import { scoreRcaCandidates } from './scorer';
import type {
  AnomalyResult,
  RcaAlertMember,
  RcaCollectorEvent,
  RcaEntityInput,
  RcaIncidentRecord,
  RcaObservation,
} from './types';

/**
 * Implementación del contrato RcaEngine. Determinista, sin LLM ni Holmes.
 * No muta Incident.status. tenantId en toda lectura.
 */
@Injectable()
export class DeterministicRcaEngine implements RcaEngine {
  private readonly logger = new Logger(DeterministicRcaEngine.name);

  constructor(
    @Inject(RCA_INCIDENT_SOURCE)
    private readonly incidents: RcaIncidentSource,
    @Inject(TOPOLOGY_REPOSITORY)
    private readonly topology: TopologyRepository,
    @Inject(HISTORICAL_EVIDENCE_PORT)
    private readonly historical: HistoricalEvidencePort,
    @Inject(ANOMALY_EVIDENCE_PORT)
    private readonly anomalies: AnomalyEvidencePort,
    @Inject(RCA_SCORING_POLICY)
    private readonly policy: RcaScoringPolicyLoader,
    private readonly metrics: RcaMetrics,
    @Optional() platformMetrics?: MetricsService,
  ) {
    platformMetrics?.registerContributor('aiops-rca', () =>
      this.metrics.render(),
    );
  }

  async propose(input: RcaProposeInput): Promise<RootCauseCandidate[]> {
    const started = process.hrtime.bigint();
    this.metrics.recordRequest();
    if (!input.tenantId) {
      this.metrics.recordCompleted(elapsedSeconds(started), 'error');
      this.logger.log(
        `aiops RcaEngine.propose rejected missing tenantId incidentId=${input.incidentId}`,
      );
      throw new Error('RcaEngine.propose exige tenantId.');
    }
    try {
      const candidates = await this.proposeScoped(input);
      const duration = elapsedSeconds(started);
      const leading = candidates[0];
      this.metrics.recordCompleted(
        duration,
        candidates.length > 0 ? 'ok' : 'empty',
        leading?.confidence,
      );
      this.logger.log(
        `aiops RcaEngine.propose completed tenantId=${input.tenantId} incidentId=${input.incidentId} candidates=${candidates.length} duration_s=${duration.toFixed(3)} algorithm=${RCA_ALGORITHM}`,
      );
      return candidates;
    } catch (error) {
      this.metrics.recordCompleted(elapsedSeconds(started), 'error');
      this.logger.log(
        `aiops RcaEngine.propose failed tenantId=${input.tenantId} incidentId=${input.incidentId} error=${error instanceof Error ? error.message : 'unknown'}`,
      );
      throw error;
    }
  }

  private async proposeScoped(
    input: RcaProposeInput,
  ): Promise<RootCauseCandidate[]> {
    const incident = await this.incidents.getIncident(
      input.tenantId,
      input.incidentId,
    );
    if (!incident || incident.tenantId !== input.tenantId) {
      this.logger.log(
        `aiops RcaEngine.propose no incident tenantId=${input.tenantId} incidentId=${input.incidentId}`,
      );
      return [];
    }
    const members = parseMembers(incident.members);
    const fingerprints = unique([
      ...members.alerts.map((alert) => alert.fingerprint),
      ...members.collectorEvents.map((event) => event.fingerprint),
    ]);
    const [collectorEvents, graph, loadedWeights, loadedHops] =
      await Promise.all([
        this.incidents.getCollectorEvents(input.tenantId, fingerprints),
        this.incidents.getGraph(input.tenantId, incident.siteId),
        this.policy.getWeights(input.tenantId),
        this.policy.getHops(input.tenantId),
      ]);
    const fromInput = policyFromInput(input);
    const weights = fromInput?.weights ?? loadedWeights;
    const hops = fromInput?.hops ?? loadedHops;
    const seedKeys = resolveEntityKeys(
      input,
      incident,
      members,
      collectorEvents,
      [],
    );
    const anomalyRows =
      input.anomalies && input.anomalies.length > 0
        ? input.anomalies
            .filter((row) => row.tenantId === input.tenantId)
            .map(toInternalAnomaly)
        : (
            await this.anomalies.findForIncident({
              tenantId: input.tenantId,
              incidentId: input.incidentId,
              entityKeys: seedKeys,
              windowStart: incident.windowStart,
              windowEnd: incident.windowEnd,
            })
          ).filter((row) => row.tenantId === input.tenantId);
    const scopedAnomalies = anomalyRows;
    const entityKeys = resolveEntityKeys(
      input,
      incident,
      members,
      collectorEvents,
      scopedAnomalies,
    );
    if (entityKeys.length === 0) {
      return [];
    }
    const tenantNodes = graph.nodes.filter(
      (node) => node.tenantId === input.tenantId,
    );
    const tenantEdges = graph.edges.filter(
      (edge) => edge.tenantId === input.tenantId,
    );
    const observations = buildObservations(
      members.alerts,
      collectorEvents,
      scopedAnomalies,
      incident,
    );
    const entities = await this.buildEntities({
      tenantId: input.tenantId,
      incident,
      entityKeys,
      tenantNodes,
      anomalies: scopedAnomalies,
      observations,
    });
    const scored = scoreRcaCandidates({
      tenantId: input.tenantId,
      incidentId: input.incidentId,
      investigationId: input.investigationId,
      hops,
      weights,
      entities,
      affectedEntityIds: entityKeys,
      edges: tenantEdges,
      observations,
    });
    return scored.map((item, index) =>
      createScoredRootCauseCandidate({
        tenantId: input.tenantId,
        incidentId: input.incidentId,
        investigationId: input.investigationId,
        rank: index + 1,
        entityId: item.entityId,
        entityKey: item.entityId,
        entityType: item.entityType,
        hypothesis: item.hypothesis,
        score: item.score,
        confidence: item.confidence,
        evidence: item.evidence,
        source: RCA_SOURCE,
        algorithm: item.algorithm,
        findingIds: [],
        affectedEntities: item.affectedEntities,
        affectedServices: item.affectedServices,
        firstObservedAt: item.firstObservedAt,
        subscores: item.subscores,
        weights: item.weights,
      }),
    );
  }

  private async buildEntities(input: {
    tenantId: string;
    incident: RcaIncidentRecord;
    entityKeys: string[];
    tenantNodes: Array<{ entityKey: string; kind: string; name: string }>;
    anomalies: AnomalyResult[];
    observations: RcaObservation[];
  }): Promise<RcaEntityInput[]> {
    const byKey = new Map(
      input.tenantNodes.map((node) => [node.entityKey, node]),
    );
    const entities: RcaEntityInput[] = [];
    for (const entityId of input.entityKeys) {
      const owned = await this.topology.getEntity(input.tenantId, entityId);
      const node = owned ?? byKey.get(entityId);
      const anomaly = input.anomalies.find((row) => row.entityId === entityId);
      const historical = await this.historical.lookup({
        tenantId: input.tenantId,
        incidentId: input.incident.id,
        entityId,
        entityType: node?.kind ?? anomaly?.entityType,
        causeKey: input.incident.causeKey,
        clusterKey: input.incident.clusterKey,
      });
      const historicalScore = historical.available
        ? historical.score
        : NEUTRAL_HISTORICAL_SCORE;
      entities.push({
        entityId,
        entityType: node?.kind ?? anomaly?.entityType,
        name: node?.name ?? entityId,
        firstObservedAt: firstObserved(entityId, input.observations, anomaly),
        anomaly,
        historicalAvailable: historical.available,
        historicalScore,
        historicalSummary: historical.summary,
        historicalMatches: historical.priorMatches,
      });
    }
    return entities;
  }
}

function elapsedSeconds(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e9;
}

function parseMembers(raw: unknown): {
  alerts: RcaAlertMember[];
  collectorEvents: RcaCollectorEvent[];
  impact: string[];
} {
  if (!raw || typeof raw !== 'object') {
    return { alerts: [], collectorEvents: [], impact: [] };
  }
  const members = raw as {
    alerts?: unknown;
    collectorEvents?: unknown;
    impact?: unknown;
  };
  const alerts = Array.isArray(members.alerts)
    ? members.alerts
        .map((item) => asAlert(item))
        .filter((item): item is RcaAlertMember => Boolean(item))
    : [];
  const collectorEvents = Array.isArray(members.collectorEvents)
    ? members.collectorEvents
        .map((item) => asCollector(item))
        .filter((item): item is RcaCollectorEvent => Boolean(item))
    : [];
  const impact = Array.isArray(members.impact)
    ? members.impact.filter((item): item is string => typeof item === 'string')
    : [];
  return { alerts, collectorEvents, impact };
}

function asAlert(value: unknown): RcaAlertMember | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const fingerprint = typeof row.fingerprint === 'string' ? row.fingerprint : '';
  if (!fingerprint && typeof row.name !== 'string') return null;
  return {
    fingerprint,
    name: typeof row.name === 'string' ? row.name : fingerprint,
    severity: typeof row.severity === 'string' ? row.severity : 'unknown',
    nodeHint:
      typeof row.nodeHint === 'string'
        ? row.nodeHint
        : typeof row.entityKey === 'string'
          ? row.entityKey
          : null,
    startsAt: typeof row.startsAt === 'string' ? row.startsAt : null,
  };
}

function asCollector(value: unknown): RcaCollectorEvent | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.fingerprint !== 'string') return null;
  return {
    fingerprint: row.fingerprint,
    signal: typeof row.signal === 'string' ? row.signal : '',
    assetKey: typeof row.assetKey === 'string' ? row.assetKey : null,
    entityType: typeof row.entityType === 'string' ? row.entityType : null,
    eventAt:
      row.eventAt instanceof Date
        ? row.eventAt
        : typeof row.eventAt === 'string'
          ? new Date(row.eventAt)
          : undefined,
    summary: typeof row.summary === 'string' ? row.summary : undefined,
  };
}

function resolveEntityKeys(
  input: RcaProposeInput,
  incident: RcaIncidentRecord,
  members: {
    alerts: RcaAlertMember[];
    collectorEvents: RcaCollectorEvent[];
    impact: string[];
  },
  collectorEvents: RcaCollectorEvent[],
  anomalies: AnomalyResult[],
): string[] {
  return unique([
    ...(input.entityKeys ?? []),
    input.preliminaryCauseKey,
    incident.causeKey,
    ...members.impact,
    ...members.alerts.map((alert) => alert.nodeHint),
    ...members.collectorEvents.map((event) => event.assetKey),
    ...collectorEvents.map((event) => event.assetKey),
    ...anomalies.map((row) => row.entityId),
  ]);
}

function buildObservations(
  alerts: RcaAlertMember[],
  collectorEvents: RcaCollectorEvent[],
  anomalies: AnomalyResult[],
  incident: RcaIncidentRecord,
): RcaObservation[] {
  const byFingerprint = new Map(
    collectorEvents.map((event) => [event.fingerprint, event]),
  );
  const fromAlerts: RcaObservation[] = alerts.map((alert) => {
    const collector = byFingerprint.get(alert.fingerprint);
    const startsAt = alert.startsAt ? Date.parse(alert.startsAt) : NaN;
    const observedAt = Number.isFinite(startsAt)
      ? new Date(startsAt)
      : collector?.eventAt ?? incident.windowStart ?? undefined;
    return {
      entityId: alert.nodeHint || collector?.assetKey || alert.fingerprint,
      observedAt: observedAt ?? undefined,
      summary: alert.name,
      kind: 'alert',
    };
  });
  const fromEvents: RcaObservation[] = collectorEvents.map((event) => ({
    entityId: event.assetKey || event.fingerprint,
    observedAt: event.eventAt,
    summary: event.summary ?? event.signal,
    kind: 'event',
  }));
  const fromAnomalies: RcaObservation[] = anomalies.map((row) => ({
    entityId: row.entityId,
    observedAt: row.startedAt,
    summary: row.summary ?? row.metric ?? 'anomaly',
    kind: 'anomaly',
  }));
  return [...fromAlerts, ...fromEvents, ...fromAnomalies].filter(
    (item) => item.entityId,
  );
}

function firstObserved(
  entityId: string,
  observations: RcaObservation[],
  anomaly?: AnomalyResult,
): Date | undefined {
  const times = observations
    .filter((item) => item.entityId === entityId && item.observedAt)
    .map((item) => item.observedAt!.getTime());
  if (anomaly?.startedAt) times.push(anomaly.startedAt.getTime());
  if (times.length === 0) return undefined;
  return new Date(Math.min(...times));
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function policyFromInput(input: RcaProposeInput): {
  weights: ReturnType<typeof normalizeRcaWeights>;
  hops?: number;
} | null {
  const policy = input.scoringPolicy;
  if (!policy || policy.tenantId !== input.tenantId) return null;
  return {
    weights: normalizeRcaWeights({
      temporal: policy.temporal,
      topology: policy.topology,
      anomaly: policy.anomaly,
      dependency: policy.dependency,
      historical: policy.historical,
    }),
    hops: policy.hops > 0 ? policy.hops : undefined,
  };
}

function toInternalAnomaly(row: {
  tenantId: string;
  entityId: string;
  entityType?: string;
  score: number;
  confidence: number;
  detector?: string;
  metric?: string;
  summary?: string;
  startedAt?: Date;
  metricName?: string;
  algorithm?: string;
  timestamp?: Date | string;
  metadata?: Record<string, unknown>;
}): AnomalyResult {
  const entityType =
    row.entityType ??
    (typeof row.metadata?.entityType === 'string'
      ? row.metadata.entityType
      : undefined);
  const startedAt =
    row.startedAt ??
    (row.timestamp
      ? row.timestamp instanceof Date
        ? row.timestamp
        : new Date(row.timestamp)
      : undefined);
  const summary =
    row.summary ??
    (typeof row.metadata?.summary === 'string' ? row.metadata.summary : undefined);
  return {
    tenantId: row.tenantId,
    entityId: row.entityId,
    entityType,
    score: row.score,
    confidence: row.confidence,
    detector: row.detector ?? row.algorithm,
    metric: row.metric ?? row.metricName,
    summary,
    startedAt,
  };
}
