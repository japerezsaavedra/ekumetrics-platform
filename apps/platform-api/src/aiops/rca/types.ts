import type { RcaEvidence } from '../types/rca-evidence';
import type { RcaScoreWeights, RcaSubscores } from '../types/root-cause-candidate';

/**
 * Resultado de anomalía consumido por RCA.
 * Task 1 (AnomalyEngine) puede alimentar AnomalyEvidencePort; RCA no lo implementa.
 */
export type AnomalyResult = {
  tenantId: string;
  entityId: string;
  entityType?: string;
  score: number;
  confidence: number;
  detector?: string;
  metric?: string;
  summary?: string;
  startedAt?: Date;
  endedAt?: Date;
};

export type RcaCollectorEvent = {
  fingerprint: string;
  signal: string;
  assetKey: string | null;
  entityType?: string | null;
  eventAt?: Date;
  summary?: string;
};

export type RcaAlertMember = {
  fingerprint: string;
  name: string;
  severity: string;
  nodeHint: string | null;
  startsAt?: string | null;
};

export type RcaIncidentRecord = {
  id: string;
  tenantId: string;
  siteId?: string | null;
  clusterKey?: string | null;
  causeKey?: string | null;
  causeName?: string | null;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  members?: unknown;
  title?: string;
};

export type RcaGraphNode = {
  entityKey: string;
  kind: string;
  name: string;
  tenantId: string;
};

export type RcaGraphEdge = {
  fromKey: string;
  toKey: string;
  relation: string;
  tenantId: string;
};

export type RcaObservation = {
  entityId: string;
  observedAt?: Date;
  summary: string;
  kind: 'alert' | 'event' | 'anomaly';
};

export type RcaEntityInput = {
  entityId: string;
  entityType?: string;
  name: string;
  firstObservedAt?: Date;
  anomaly?: AnomalyResult;
  historicalAvailable: boolean;
  historicalScore: number;
  historicalSummary?: string;
  historicalMatches?: number;
};

export type RcaScoreContext = {
  tenantId: string;
  incidentId: string;
  investigationId?: string;
  hops: number;
  weights: RcaScoreWeights;
  entities: RcaEntityInput[];
  affectedEntityIds: string[];
  edges: RcaGraphEdge[];
  observations: RcaObservation[];
};

export type ScoredRcaCandidate = {
  entityId: string;
  entityType?: string;
  name: string;
  score: number;
  confidence: number;
  subscores: RcaSubscores;
  weights: RcaScoreWeights;
  evidence: RcaEvidence[];
  hypothesis: string;
  affectedEntities: string[];
  affectedServices: string[];
  firstObservedAt?: Date;
  algorithm: string;
};

export type RcaRequestedPayload = {
  tenantId: string;
  incidentId: string;
  investigationId?: string;
  entityKeys?: string[];
  preliminaryCauseKey?: string;
};

export type RcaCompletedCandidate = {
  entityId: string;
  entityType?: string;
  entityKey?: string;
  rank: number;
  score: number;
  confidence: number;
  hypothesis: string;
  algorithm: string;
  source: string;
  evidence: Array<{
    kind: string;
    summary: string;
    confidence?: number;
    entityKey?: string;
    facts: Record<string, unknown>;
  }>;
  affectedEntities: string[];
  affectedServices: string[];
  firstObservedAt?: string;
  subscores: RcaSubscores;
  weights: RcaScoreWeights;
};

export type RcaCompletedPayload = {
  tenantId: string;
  incidentId: string;
  investigationId?: string;
  algorithm: string;
  durationMs: number;
  leadingScore?: number;
  leadingConfidence?: number;
  candidateCount: number;
  primaryEntityId?: string;
  rcaConfidence?: number;
  candidates: RcaCompletedCandidate[];
};
