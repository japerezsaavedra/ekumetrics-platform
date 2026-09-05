import { Injectable } from '@nestjs/common';
import { NEUTRAL_HISTORICAL_SCORE } from './constants';

export const HISTORICAL_EVIDENCE_PORT = 'HistoricalEvidencePort';

export type HistoricalEvidenceQuery = {
  tenantId: string;
  incidentId: string;
  entityId: string;
  entityType?: string;
  causeKey?: string | null;
  clusterKey?: string | null;
};

export type HistoricalEvidence = {
  /** false = no hay historia usable; score DEBE ser neutro. */
  available: boolean;
  score: number;
  priorMatches: number;
  summary?: string;
};

export interface HistoricalEvidencePort {
  lookup(query: HistoricalEvidenceQuery): Promise<HistoricalEvidence>;
}

export function neutralHistoricalEvidence(): HistoricalEvidence {
  return {
    available: false,
    score: NEUTRAL_HISTORICAL_SCORE,
    priorMatches: 0,
  };
}

/**
 * Adaptador Wave 2: Task 5 puede sustituirlo.
 * Nunca fabrica recurrencia; historicalScore queda en 0.5.
 */
@Injectable()
export class NeutralHistoricalEvidenceAdapter implements HistoricalEvidencePort {
  lookup(query: HistoricalEvidenceQuery): Promise<HistoricalEvidence> {
    if (!query.tenantId) {
      return Promise.resolve(neutralHistoricalEvidence());
    }
    return Promise.resolve(neutralHistoricalEvidence());
  }
}
