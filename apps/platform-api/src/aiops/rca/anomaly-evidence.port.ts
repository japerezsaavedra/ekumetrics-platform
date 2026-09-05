import { Injectable } from '@nestjs/common';
import type { AnomalyResult } from './types';

export const ANOMALY_EVIDENCE_PORT = 'AnomalyEvidencePort';

export type AnomalyEvidenceQuery = {
  tenantId: string;
  incidentId: string;
  entityKeys: string[];
  windowStart?: Date | null;
  windowEnd?: Date | null;
};

/**
 * Puerto de anomalías para RCA. AnomalyEngine (otra tarea) puede implementar
 * este contrato; RCA no reescribe ese motor.
 */
export interface AnomalyEvidencePort {
  findForIncident(query: AnomalyEvidenceQuery): Promise<AnomalyResult[]>;
}

/** Sin AnomalyEngine: no se inventan anomalías (anomalyScore = 0). */
@Injectable()
export class NoopAnomalyEvidenceAdapter implements AnomalyEvidencePort {
  findForIncident(query: AnomalyEvidenceQuery): Promise<AnomalyResult[]> {
    if (!query.tenantId) return Promise.resolve([]);
    return Promise.resolve([]);
  }
}
