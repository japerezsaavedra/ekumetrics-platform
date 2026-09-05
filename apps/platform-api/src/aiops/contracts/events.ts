import { EventBusValidationError } from '../../messaging/errors';
import { EventSubjects } from '../../messaging/subjects';
import type { AnomalyResult } from './anomaly';
import type { IncidentEnrichmentRecord } from './enrichment';
import type { RootCauseCandidate } from '../types/root-cause-candidate';

export { EventSubjects };
export type { EventSubject } from '../../messaging/subjects';

/**
 * Subjects Wave 2. RCA_REQUESTED / RCA_COMPLETED ya existían en Wave 1: reutilizar, no duplicar.
 */
export const Wave2EventSubjects = {
  EVENTS_INGESTED: EventSubjects.EVENTS_INGESTED,
  ANOMALIES_DETECTED: EventSubjects.ANOMALIES_DETECTED,
  INCIDENTS_ENRICHMENT_REQUESTED: EventSubjects.INCIDENTS_ENRICHMENT_REQUESTED,
  INCIDENTS_ENRICHED: EventSubjects.INCIDENTS_ENRICHED,
  RCA_REQUESTED: EventSubjects.RCA_REQUESTED,
  RCA_COMPLETED: EventSubjects.RCA_COMPLETED,
} as const;

export type AiopsBusPayload = {
  tenantId: string;
};

export type EventsIngestedPayload = AiopsBusPayload & {
  agentEventId: string;
  fingerprint?: string;
  siteId?: string;
  agentId?: string;
  entityId?: string;
  entityType?: string;
  assetKey?: string;
  signal: string;
  category?: string;
  timestamp: string;
  eventAt?: string;
  value?: number;
  metricName?: string;
  environment?: string;
  labels?: Record<string, string>;
  attributes?: Record<string, string | number | boolean>;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
};

export type AnomaliesDetectedPayload = AiopsBusPayload & {
  anomalies: AnomalyResult[];
  detectorType?: string;
  incidentId?: string;
};

export type IncidentEnrichmentRequestedPayload = AiopsBusPayload & {
  incidentId: string;
};

export type IncidentEnrichedPayload = AiopsBusPayload & {
  incidentId: string;
  enrichment: IncidentEnrichmentRecord;
};

export type RcaRequestedPayload = AiopsBusPayload & {
  incidentId: string;
  investigationId?: string;
};

export type RcaCompletedPayload = AiopsBusPayload & {
  incidentId: string;
  investigationId?: string;
  candidateCount: number;
  primaryEntityId?: string;
  rcaConfidence?: number;
  candidates?: RootCauseCandidate[];
};

export type InvestigationLifecyclePayload = AiopsBusPayload & {
  incidentId: string;
  investigationId: string;
  version: number;
  status?: string;
  trigger?: string;
};

export type AiopsAgentLifecyclePayload = AiopsBusPayload & {
  incidentId: string;
  investigationId: string;
  agentType: string;
  status: string;
};

export function assertAiopsBusPayload(
  payload: unknown,
): asserts payload is AiopsBusPayload {
  if (!payload || typeof payload !== 'object') {
    throw new EventBusValidationError('AIOps EventBus payload is required');
  }
  const tenantId = (payload as { tenantId?: unknown }).tenantId;
  if (typeof tenantId !== 'string' || !tenantId.trim()) {
    throw new EventBusValidationError(
      'AIOps EventBus payload requires tenantId',
    );
  }
}
