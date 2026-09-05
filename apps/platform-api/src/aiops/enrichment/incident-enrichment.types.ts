import type {
  RootCauseCandidateStatus,
  RootCauseSource,
} from '../types/root-cause-candidate';
import {
  RCA_FEEDBACK_ACTIONS,
  isRcaFeedbackAction,
  parseRcaFeedbackAction,
  type RcaFeedbackAction,
} from '../contracts/rca-feedback';

export const INCIDENT_ENRICHMENT_ALGORITHM = 'deterministic_enrichment_v1';
export const INCIDENT_ENRICHMENT_SCHEMA_VERSION = 1;
export const INCIDENT_ENRICHMENT_SOURCE = 'aiops.enrichment';
export const RCA_ENGINE_ALGORITHM = 'weighted_subscores_v1';
export const RCA_ENGINE_SOURCE = 'deterministic_rca';

export { RCA_FEEDBACK_ACTIONS, isRcaFeedbackAction, parseRcaFeedbackAction };
export type { RcaFeedbackAction };

export const INCIDENT_PRIORITY_LEVELS = ['P1', 'P2', 'P3', 'P4'] as const;
export type IncidentPriorityLevel = (typeof INCIDENT_PRIORITY_LEVELS)[number];

export const PRIORITY_FACTOR_IDS = [
  'severity',
  'serviceCriticality',
  'blastRadius',
  'environment',
  'affectedEntityCount',
  'tenantPolicy',
] as const;
export type PriorityFactorId = (typeof PRIORITY_FACTOR_IDS)[number];

/** Evidencia explicable: score + confidence + algorithm + source. */
export type EnrichmentEvidence = {
  kind: string;
  statement: string;
  score: number;
  confidence: number;
  algorithm: string;
  source: string;
  details?: Record<string, string | number | boolean | null>;
};

export type EnrichedEntity = {
  entityKey: string;
  name: string;
  kind: string;
  role: 'cause' | 'impact' | 'alert' | 'service' | 'neighbor';
  score: number;
  confidence: number;
  algorithm: string;
  source: string;
  evidence: EnrichmentEvidence[];
};

export type BlastRadius = {
  originKey: string | null;
  hops: number;
  entityCount: number;
  entityKeys: string[];
  score: number;
  confidence: number;
  algorithm: string;
  source: string;
  evidence: EnrichmentEvidence[];
};

export type IncidentAnomaly = {
  id: string;
  occurredAt: string;
  summary: string;
  entityKey?: string;
  kind: 'latency' | 'saturation' | 'error' | 'timeout' | 'metric' | 'other';
  score: number;
  confidence: number;
  algorithm: string;
  source: string;
  evidence: EnrichmentEvidence[];
};

export const TIMELINE_KINDS = [
  'anomaly',
  'change',
  'alert',
  'error',
  'topology',
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export type TimelineEntry = {
  occurredAt: string;
  sequence: number;
  summary: string;
  kind: TimelineKind;
  entityKey?: string;
  source: string;
  algorithm: string;
  score: number;
  confidence: number;
  evidence: EnrichmentEvidence[];
};

export type RecentChange = {
  occurredAt: string;
  summary: string;
  entityKey?: string;
  fingerprint?: string;
  score: number;
  confidence: number;
  algorithm: string;
  source: string;
  evidence: EnrichmentEvidence[];
};

export type HistoricalMatch = {
  incidentId: string;
  title: string;
  causeKey?: string | null;
  clusterKey?: string | null;
  status?: string;
  score: number;
  confidence: number;
  algorithm: string;
  source: string;
  evidence: EnrichmentEvidence[];
};

export type CorrelationEvidenceItem = EnrichmentEvidence;

export type RootCauseCandidateView = {
  id: string;
  tenantId: string;
  incidentId: string;
  rank: number;
  entityKey?: string;
  hypothesis: string;
  confidence: number;
  score: number;
  status: RootCauseCandidateStatus;
  source: RootCauseSource;
  algorithm: string;
  evidence: EnrichmentEvidence[];
};

export type PriorityFactorBreakdown = {
  id: PriorityFactorId;
  score: number;
  weight: number;
  weighted: number;
  evidence: string;
  algorithm: string;
  source: string;
  confidence: number;
};

export type ComputedPriority = {
  level: IncidentPriorityLevel;
  score: number;
  confidence: number;
  algorithm: string;
  source: string;
  evidence: EnrichmentEvidence[];
  factors: PriorityFactorBreakdown[];
};

export type RcaOperatorFeedback = {
  action: RcaFeedbackAction;
  candidateId?: string;
  note?: string;
  actor?: string;
  at: string;
  source: string;
  algorithm: string;
};

export type IncidentEnrichment = {
  tenantId: string;
  incidentId: string;
  schemaVersion: number;
  algorithm: string;
  source: string;
  score: number;
  confidence: number;
  evidence: EnrichmentEvidence[];
  computedPriority: ComputedPriority;
  affectedEntities: EnrichedEntity[];
  affectedServices: EnrichedEntity[];
  blastRadius: BlastRadius;
  topologyEvidence: EnrichmentEvidence[];
  anomalies: IncidentAnomaly[];
  rootCauseCandidates: RootCauseCandidateView[];
  primaryRootCause: RootCauseCandidateView | null;
  rcaConfidence: number | null;
  correlationEvidence: CorrelationEvidenceItem[];
  timeline: TimelineEntry[];
  recentChanges: RecentChange[];
  historicalMatches: HistoricalMatch[];
  operatorFeedback: RcaOperatorFeedback[];
  rcaMode: 'deterministic_engine' | 'correlation_fallback';
  aiInvestigationStatus:
    | 'not_executed'
    | 'PENDING'
    | 'RUNNING'
    | 'PARTIAL'
    | 'COMPLETED'
    | 'FAILED'
    | 'TIMEOUT'
    | 'CANCELLED';
  investigationId?: string;
  investigationVersion?: number;
  investigationConfidence?: number | null;
  synthesisSummary?: string;
  enrichedAt: string;
};

export type EnrichmentRequestedPayload = {
  tenantId: string;
  incidentId: string;
};

export type IncidentEnrichedPayload = {
  tenantId: string;
  incidentId: string;
  algorithm: string;
  source: string;
  score: number;
  confidence: number;
  priority: IncidentPriorityLevel;
  rcaConfidence: number | null;
};

export type RcaFeedbackInput = {
  action: string;
  candidateId?: string;
  note?: string;
  actor?: string;
};

export type IncidentMembersView = {
  alerts: Array<{
    fingerprint: string;
    name: string;
    severity: string;
    nodeHint: string | null;
    startsAt?: string | null;
  }>;
  impact: string[];
  correlation?: {
    score: number;
    evidence?: string[];
    details?: Array<{
      kind: string;
      statement: string;
      score: number;
      details?: Record<string, string | number | boolean | null>;
    }>;
  };
  collectorEvents: Array<{
    fingerprint: string;
    signal: string;
    assetKey: string | null;
  }>;
};

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
