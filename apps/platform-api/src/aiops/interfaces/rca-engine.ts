import type { AnomalyResult } from '../contracts/anomaly';
import type { IncidentEnrichmentRecord } from '../contracts/enrichment';
import type { RcaScoringPolicyRecord } from '../contracts/rca-scoring-policy';
import type { TopologyImpactResult } from '../contracts/topology-impact';
import type { RootCauseCandidate } from '../types/root-cause-candidate';

export const RCA_ENGINE = 'RcaEngine';

export type RcaProposeInput = {
  tenantId: string;
  incidentId: string;
  investigationId?: string;
  entityKeys?: string[];
  preliminaryCauseKey?: string;
  scoringPolicy?: RcaScoringPolicyRecord;
  anomalies?: AnomalyResult[];
  topologyImpact?: TopologyImpactResult;
  enrichment?: IncidentEnrichmentRecord;
};

/**
 * Motor RCA determinista (grafo / scoring).
 * Wave 1: contrato + stub. Wave 2: implementación en el workstream RCA (no aquí).
 * Sin LLM, sin Holmes, sin mutar Incident.status.
 */
export interface RcaEngine {
  propose(input: RcaProposeInput): Promise<RootCauseCandidate[]>;
}
