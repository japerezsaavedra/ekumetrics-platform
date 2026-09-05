import type {
  DimensionScore,
  HistoricalMatchEvidence,
  IncidentSignature,
  ResolutionRecord,
  StableSignatureCharacteristics,
} from './types';
import {
  HISTORICAL_ALGORITHM,
  HISTORICAL_SOURCE,
} from './types';

/** Pesos de dimensiones de firma. Suman 1. rootCause es bonus aparte. */
export const SIMILARITY_WEIGHTS = {
  service: 0.25,
  entityTypes: 0.2,
  eventTypes: 0.2,
  anomalyTypes: 0.15,
  topologyPattern: 0.15,
  environment: 0.05,
} as const;

/** Si eventos y topología discrepan fuerte, el score no puede acercarse a 1.0. */
export const DISAGREEMENT_CAP = 0.45;
export const ROOT_CAUSE_BONUS = 0.08;

export type SimilarityBreakdown = {
  similarity: number;
  confidence: number;
  dimensions: DimensionScore[];
  evidence: HistoricalMatchEvidence;
};

export function scoreSignatureSimilarity(
  query: StableSignatureCharacteristics,
  candidate: Pick<
    IncidentSignature,
    | 'hash'
    | 'entityTypes'
    | 'serviceKey'
    | 'eventTypes'
    | 'anomalyTypes'
    | 'topologyPattern'
    | 'environment'
  >,
  options?: {
    queryRootCause?: string;
    resolution?: Pick<
      ResolutionRecord,
      'incidentId' | 'confirmedRootCause' | 'rejectedRootCauses'
    >;
  },
): SimilarityBreakdown {
  const dimensions: DimensionScore[] = [
    scoreExact(
      'service',
      SIMILARITY_WEIGHTS.service,
      query.serviceKey,
      candidate.serviceKey,
      'servicio',
    ),
    scoreJaccard(
      'entityTypes',
      SIMILARITY_WEIGHTS.entityTypes,
      query.entityTypes,
      candidate.entityTypes,
      'tipos de entidad',
    ),
    scoreJaccard(
      'eventTypes',
      SIMILARITY_WEIGHTS.eventTypes,
      query.eventTypes,
      candidate.eventTypes,
      'patrón de eventos',
    ),
    scoreJaccard(
      'anomalyTypes',
      SIMILARITY_WEIGHTS.anomalyTypes,
      query.anomalyTypes,
      candidate.anomalyTypes,
      'tipos de anomalía',
    ),
    scoreJaccard(
      'topologyPattern',
      SIMILARITY_WEIGHTS.topologyPattern,
      splitPattern(query.topologyPattern),
      splitPattern(candidate.topologyPattern),
      'camino de topología',
    ),
    scoreExact(
      'environment',
      SIMILARITY_WEIGHTS.environment,
      query.environment,
      candidate.environment,
      'entorno',
    ),
  ];

  const rootCause = scoreRootCause(
    options?.queryRootCause,
    options?.resolution?.confirmedRootCause,
  );
  if (rootCause) {
    dimensions.push(rootCause);
  }

  let similarity = weightedMean(dimensions);
  similarity = applyDisagreementCap(dimensions, similarity);
  if (rootCause?.matched) {
    similarity = Math.min(1, similarity + ROOT_CAUSE_BONUS);
  }
  similarity = roundScore(similarity);

  const active = dimensions.filter((item) => !item.skipped);
  const matchedCount = active.filter((item) => item.matched).length;
  const coverage = active.length === 0 ? 0 : matchedCount / active.length;
  const confidence = roundScore(similarity * (0.5 + 0.5 * coverage));

  const summary = buildSummary(dimensions, similarity);
  const incidentId = options?.resolution?.incidentId ?? '';
  const evidence: HistoricalMatchEvidence = {
    kind: 'historical',
    summary,
    score: similarity,
    confidence,
    algorithm: HISTORICAL_ALGORITHM,
    source: HISTORICAL_SOURCE,
    facts: {
      dimensions,
      candidateIncidentId: incidentId,
      signatureHash: candidate.hash,
    },
  };

  return { similarity, confidence, dimensions, evidence };
}

export function jaccard(left: string[], right: string[]): number | null {
  if (left.length === 0 && right.length === 0) return null;
  const a = new Set(left);
  const b = new Set(right);
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = new Set([...a, ...b]).size;
  if (union === 0) return null;
  return intersection / union;
}

function scoreExact(
  dimension: DimensionScore['dimension'],
  weight: number,
  left: string,
  right: string,
  label: string,
): DimensionScore {
  if (!left && !right) {
    return skipped(dimension, weight, `Sin ${label} en ambos lados`);
  }
  const matched = Boolean(left) && left === right;
  const score = matched ? 1 : 0;
  return {
    dimension,
    matched,
    skipped: false,
    score,
    weight,
    detail: matched
      ? `Mismo ${label}: ${left}`
      : `${label} distinto (${left || 'vacío'} vs ${right || 'vacío'})`,
  };
}

function scoreJaccard(
  dimension: DimensionScore['dimension'],
  weight: number,
  left: string[],
  right: string[],
  label: string,
): DimensionScore {
  const value = jaccard(left, right);
  if (value === null) {
    return skipped(dimension, weight, `Sin ${label} en ambos lados`);
  }
  return {
    dimension,
    matched: value >= 0.99,
    skipped: false,
    score: value,
    weight,
    detail:
      value >= 0.99
        ? `Mismo ${label}`
        : `${label} Jaccard ${roundScore(value)}`,
  };
}

function scoreRootCause(
  queryCause: string | undefined,
  confirmed: string | undefined,
): DimensionScore | null {
  const left = normalizeCause(queryCause);
  const right = normalizeCause(confirmed);
  if (!left || !right) return null;
  const matched = left === right;
  return {
    dimension: 'rootCause',
    matched,
    skipped: false,
    score: matched ? 1 : 0,
    weight: 0,
    detail: matched
      ? `Misma causa raíz confirmada: ${right}`
      : `Causa raíz distinta (${left} vs ${right})`,
  };
}

function applyDisagreementCap(
  dimensions: DimensionScore[],
  similarity: number,
): number {
  const events = dimensions.find((item) => item.dimension === 'eventTypes');
  const topology = dimensions.find(
    (item) => item.dimension === 'topologyPattern',
  );
  if (!events || events.skipped || !topology || topology.skipped) {
    return similarity;
  }
  if (events.score < 0.2 && topology.score < 0.2) {
    return Math.min(similarity, DISAGREEMENT_CAP);
  }
  return similarity;
}

function weightedMean(dimensions: DimensionScore[]): number {
  const active = dimensions.filter(
    (item) => !item.skipped && item.weight > 0,
  );
  const totalWeight = active.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return 0;
  const acc = active.reduce(
    (sum, item) => sum + item.score * item.weight,
    0,
  );
  return acc / totalWeight;
}

function skipped(
  dimension: DimensionScore['dimension'],
  weight: number,
  detail: string,
): DimensionScore {
  return {
    dimension,
    matched: false,
    skipped: true,
    score: 0,
    weight,
    detail,
  };
}

function splitPattern(pattern: string): string[] {
  return pattern.split('>').filter((item) => item.length > 0);
}

function normalizeCause(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function buildSummary(
  dimensions: DimensionScore[],
  similarity: number,
): string {
  const highlights = dimensions
    .filter((item) => !item.skipped)
    .map((item) => item.detail);
  const preview = highlights.slice(0, 4).join('; ');
  return `Similitud histórica ${similarity}${preview ? `: ${preview}` : ''}.`;
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
