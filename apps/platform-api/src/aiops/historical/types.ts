/**
 * Fundación de inteligencia histórica AIOps (wave 2).
 * Tipos in-module alineados al contrato propuesto (Prisma lo cableará el coordinador).
 * No hay embeddings: similitud determinista. tenantId es obligatorio en todo registro.
 */

export const HISTORICAL_ALGORITHM = 'deterministic_jaccard_v1' as const;
export const HISTORICAL_SOURCE = 'historical_intelligence' as const;
export const NEUTRAL_HISTORICAL_SCORE = 0.5;
export const SIGNATURE_VERSION = 'v1' as const;

export const RCA_FEEDBACK_ACTIONS = [
  'CONFIRM',
  'REJECT',
  'SELECT_ALTERNATIVE',
  'ADD_NOTE',
] as const;

export type RcaFeedbackAction = (typeof RCA_FEEDBACK_ACTIONS)[number];

export const HISTORICAL_DIMENSIONS = [
  'service',
  'entityTypes',
  'eventTypes',
  'anomalyTypes',
  'topologyPattern',
  'environment',
  'rootCause',
] as const;

export type HistoricalDimension = (typeof HISTORICAL_DIMENSIONS)[number];

/**
 * Características ESTABLES de un incidente. Los IDs volátiles se aceptan
 * en el input para no romper callers, pero no entran al hash.
 */
export type IncidentSignatureInput = {
  tenantId: string;
  entityTypes?: string[];
  service?: string;
  serviceKey?: string;
  eventTypes?: string[];
  anomalyTypes?: string[];
  topologyPattern?: string | string[];
  environment?: string;
  proposedRootCause?: string;
  entityIds?: string[];
  entityKeys?: string[];
  nodeKeys?: string[];
  incidentId?: string;
  fingerprints?: string[];
  timestamps?: Array<string | Date | number>;
  assetIds?: string[];
};

export type StableSignatureCharacteristics = {
  entityTypes: string[];
  serviceKey: string;
  eventTypes: string[];
  anomalyTypes: string[];
  topologyPattern: string;
  environment: string;
};

export type IncidentSignature = {
  id: string;
  tenantId: string;
  hash: string;
  version: typeof SIGNATURE_VERSION;
  entityTypes: string[];
  serviceKey: string;
  eventTypes: string[];
  anomalyTypes: string[];
  topologyPattern: string;
  environment: string;
  incidentIds: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type ResolutionRecord = {
  id: string;
  tenantId: string;
  incidentId: string;
  signatureId?: string;
  confirmedRootCause?: string;
  rejectedRootCauses: string[];
  resolution?: string;
  successfulAction?: string;
  timeToDetectMs?: number;
  timeToResolveMs?: number;
  createdAt: Date;
  updatedAt: Date;
};

export type RcaFeedback = {
  id: string;
  tenantId: string;
  incidentId: string;
  action: RcaFeedbackAction;
  selectedEntityId?: string;
  note?: string;
  userId?: string;
  createdAt: Date;
};

export type DimensionScore = {
  dimension: HistoricalDimension;
  matched: boolean;
  skipped: boolean;
  score: number;
  weight: number;
  detail: string;
};

export type HistoricalMatchEvidence = {
  kind: 'historical';
  summary: string;
  score: number;
  confidence: number;
  algorithm: typeof HISTORICAL_ALGORITHM;
  source: typeof HISTORICAL_SOURCE;
  facts: {
    dimensions: DimensionScore[];
    candidateIncidentId: string;
    signatureHash: string;
  };
};

export type HistoricalMatch = {
  incidentId: string;
  signatureId: string;
  signatureHash: string;
  similarity: number;
  confidence: number;
  evidence: HistoricalMatchEvidence[];
  algorithm: typeof HISTORICAL_ALGORITHM;
  source: typeof HISTORICAL_SOURCE;
  confirmedRootCause?: string;
  rejectedRootCauses: string[];
  resolution?: string;
  successfulAction?: string;
};

/**
 * Señal para RcaEngine. Nunca es un veto: overridesCurrentEvidence es siempre false.
 * Sin historial: historicalScore = NEUTRAL (0.5), matches vacíos, stance NEUTRAL.
 */
export type HistoricalContribution = {
  tenantId: string;
  historicalScore: number;
  confidence: number;
  matches: HistoricalMatch[];
  stance: 'NEUTRAL' | 'SUPPORTING';
  overridesCurrentEvidence: false;
  algorithm: typeof HISTORICAL_ALGORITHM;
  source: typeof HISTORICAL_SOURCE;
  evidence: HistoricalMatchEvidence[];
};

export function isRcaFeedbackAction(value: string): value is RcaFeedbackAction {
  return (RCA_FEEDBACK_ACTIONS as readonly string[]).includes(value);
}
