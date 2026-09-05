import type { RootCauseCandidate } from '../types/root-cause-candidate';
import type { AnomalyResult } from './anomaly';
import type { HistoricalMatch } from './historical';
import type { BlastRadius } from './topology-impact';

/**
 * Vista de dominio del snapshot 1:1 IncidentEnrichment.
 * Coincide con columnas Prisma: indexadas vs JSON.
 */
export type IncidentEnrichmentRecord = {
  tenantId: string;
  incidentId: string;
  primaryRootCause?: string;
  rcaConfidence?: number;
  affectedServiceCount?: number;
  affectedEntities?: string[];
  affectedServices?: string[];
  blastRadius?: BlastRadius;
  topologyEvidence?: unknown;
  anomalies?: AnomalyResult[];
  rootCauseCandidates?: RootCauseCandidate[];
  correlationEvidence?: unknown;
  timeline?: unknown;
  recentChanges?: unknown;
  historicalMatches?: HistoricalMatch[];
  createdAt?: Date;
  updatedAt?: Date;
};
