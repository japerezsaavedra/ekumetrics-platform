import type { RcaScoreWeights } from '../types/root-cause-candidate';

/**
 * Pesos configurables de RCA. No es la fórmula del motor:
 * RcaEngine (workstream RCA) lee esta política; no hardcodear el score final.
 * Defaults suman 1.0. Claves alineadas con RcaScoreWeights (candidato).
 * Persistencia Prisma: temporalWeight, topologyWeight, … (ver toPrismaRcaWeights).
 */
export type RcaScoringWeights = RcaScoreWeights;

export const DEFAULT_RCA_SCORING_WEIGHTS: RcaScoringWeights = {
  temporal: 0.2,
  topology: 0.25,
  anomaly: 0.2,
  dependency: 0.25,
  historical: 0.1,
};

export type RcaSuppressionConfig = {
  enabled: boolean;
  minTopologyConfidence?: number;
};

export type RcaScoringPolicyRecord = RcaScoringWeights & {
  tenantId: string;
  environment: string;
  hops: number;
  suppressionEnabled: boolean;
  minTopologyConfidence?: number;
  config?: Record<string, unknown>;
};

export type PrismaRcaWeightColumns = {
  temporalWeight: number;
  topologyWeight: number;
  anomalyWeight: number;
  dependencyWeight: number;
  historicalWeight: number;
};

export function rcaScoringWeightsTotal(weights: RcaScoringWeights): number {
  return (
    weights.temporal +
    weights.topology +
    weights.anomaly +
    weights.dependency +
    weights.historical
  );
}

export function normalizeRcaScoringWeights(
  weights: RcaScoringWeights,
): RcaScoringWeights {
  const total = rcaScoringWeightsTotal(weights);
  if (total <= 0) return { ...DEFAULT_RCA_SCORING_WEIGHTS };
  return {
    temporal: weights.temporal / total,
    topology: weights.topology / total,
    anomaly: weights.anomaly / total,
    dependency: weights.dependency / total,
    historical: weights.historical / total,
  };
}

export function toPrismaRcaWeights(
  weights: RcaScoringWeights,
): PrismaRcaWeightColumns {
  const normalized = normalizeRcaScoringWeights(weights);
  return {
    temporalWeight: normalized.temporal,
    topologyWeight: normalized.topology,
    anomalyWeight: normalized.anomaly,
    dependencyWeight: normalized.dependency,
    historicalWeight: normalized.historical,
  };
}

export function fromPrismaRcaWeights(
  row: PrismaRcaWeightColumns,
): RcaScoringWeights {
  return normalizeRcaScoringWeights({
    temporal: row.temporalWeight,
    topology: row.topologyWeight,
    anomaly: row.anomalyWeight,
    dependency: row.dependencyWeight,
    historical: row.historicalWeight,
  });
}

export function defaultRcaScoringPolicy(
  tenantId: string,
  environment = '',
): RcaScoringPolicyRecord {
  if (!tenantId.trim()) {
    throw new Error('RcaScoringPolicy.tenantId es obligatorio.');
  }
  return {
    tenantId,
    environment,
    ...DEFAULT_RCA_SCORING_WEIGHTS,
    hops: 8,
    suppressionEnabled: false,
  };
}
