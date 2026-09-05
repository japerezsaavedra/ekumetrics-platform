import type {
  HistoricalContribution,
  IncidentSignatureInput,
} from './types';
import {
  HISTORICAL_ALGORITHM,
  HISTORICAL_SOURCE,
  NEUTRAL_HISTORICAL_SCORE,
} from './types';

export const HISTORICAL_EVIDENCE = Symbol('HISTORICAL_EVIDENCE');

/**
 * Puerto que RcaEngine (wave 2 task 2) puede inyectar.
 * lookup(tenantId, signature) nunca cruza tenants ni fabrica matches.
 */
export interface HistoricalEvidencePort {
  lookup(
    tenantId: string,
    signature: IncidentSignatureInput,
  ): Promise<HistoricalContribution>;
}

export function neutralHistoricalContribution(
  tenantId: string,
): HistoricalContribution {
  return {
    tenantId,
    historicalScore: NEUTRAL_HISTORICAL_SCORE,
    confidence: 0,
    matches: [],
    stance: 'NEUTRAL',
    overridesCurrentEvidence: false,
    algorithm: HISTORICAL_ALGORITHM,
    source: HISTORICAL_SOURCE,
    evidence: [
      {
        kind: 'historical',
        summary:
          'Sin historial del mismo tenant para esta firma. Contribución NEUTRAL; no se fabrica evidencia.',
        score: NEUTRAL_HISTORICAL_SCORE,
        confidence: 0,
        algorithm: HISTORICAL_ALGORITHM,
        source: HISTORICAL_SOURCE,
        facts: {
          dimensions: [],
          candidateIncidentId: '',
          signatureHash: '',
        },
      },
    ],
  };
}

/** Adaptador vacío para tests de RcaEngine sin store histórico. */
export class NeutralHistoricalEvidence implements HistoricalEvidencePort {
  lookup(
    tenantId: string,
    _signature: IncidentSignatureInput,
  ): Promise<HistoricalContribution> {
    if (!tenantId) {
      return Promise.reject(new Error('tenantId es obligatorio.'));
    }
    return Promise.resolve(neutralHistoricalContribution(tenantId));
  }
}
