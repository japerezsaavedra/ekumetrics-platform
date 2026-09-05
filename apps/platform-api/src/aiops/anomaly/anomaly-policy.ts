import type { AnomalyAlgorithm } from './anomaly-result';
export type { AnomalyAlgorithm };

export const DEFAULT_ANOMALY_POLICY = {
  minScore: 0.35,
  minSamples: 8,
  ewmaAlpha: 0.3,
  ewmaLambda: 0.05,
  robustZThreshold: 3.5,
  rollingIqrK: 1.5,
  staleMs: 5 * 60 * 1000,
  enabledDetectors: [
    'static_threshold',
    'rolling_baseline',
    'robust_zscore',
    'ewma',
  ] as AnomalyAlgorithm[],
};

export type AnomalyDirection = 'above' | 'below';

export type AnomalyPolicy = {
  id: string;
  tenantId: string;
  siteId?: string;
  entityType?: string;
  entityId?: string;
  metricName?: string;
  environment?: string;
  enabledDetectors?: AnomalyAlgorithm[];
  minScore?: number;
  minSamples?: number;
  ewmaAlpha?: number;
  ewmaLambda?: number;
  robustZThreshold?: number;
  rollingIqrK?: number;
  staleMs?: number;
  warn?: number;
  crit?: number;
  direction?: AnomalyDirection;
};

export type ResolvedAnomalyPolicy = {
  tenantId: string;
  policyId?: string;
  enabledDetectors: AnomalyAlgorithm[];
  minScore: number;
  minSamples: number;
  ewmaAlpha: number;
  ewmaLambda: number;
  robustZThreshold: number;
  rollingIqrK: number;
  staleMs: number;
  warn?: number;
  crit?: number;
  direction: AnomalyDirection;
};

export type PolicyMatchInput = {
  tenantId: string;
  siteId?: string;
  entityType?: string;
  entityId?: string;
  metricName: string;
  environment?: string;
};

function clipPositive(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function clipUnit(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function matches(policy: AnomalyPolicy, input: PolicyMatchInput): boolean {
  if (policy.tenantId !== input.tenantId) return false;
  if (policy.siteId && policy.siteId !== input.siteId) return false;
  if (policy.entityType && policy.entityType !== input.entityType) return false;
  if (policy.entityId && policy.entityId !== input.entityId) return false;
  if (policy.metricName && policy.metricName !== input.metricName) return false;
  if (policy.environment && policy.environment !== input.environment) {
    return false;
  }
  return true;
}

function specificity(policy: AnomalyPolicy): number {
  let score = 0;
  if (policy.entityId) score += 16;
  if (policy.metricName) score += 10;
  if (policy.siteId) score += 8;
  if (policy.entityType) score += 4;
  if (policy.environment) score += 2;
  return score;
}

export function resolveAnomalyPolicy(
  tenantId: string,
  policies: AnomalyPolicy[],
  input: Omit<PolicyMatchInput, 'tenantId'>,
): ResolvedAnomalyPolicy {
  const scoped = policies.filter((policy) =>
    matches(policy, { ...input, tenantId }),
  );
  scoped.sort((left, right) => specificity(right) - specificity(left));
  const hit = scoped[0];
  const alpha = clipUnit(hit?.ewmaAlpha, DEFAULT_ANOMALY_POLICY.ewmaAlpha);
  const lambda = clipUnit(hit?.ewmaLambda, DEFAULT_ANOMALY_POLICY.ewmaLambda);
  return {
    tenantId,
    policyId: hit?.id,
    enabledDetectors:
      hit?.enabledDetectors ?? DEFAULT_ANOMALY_POLICY.enabledDetectors,
    minScore: clipUnit(hit?.minScore, DEFAULT_ANOMALY_POLICY.minScore),
    minSamples: Math.trunc(
      clipPositive(hit?.minSamples, DEFAULT_ANOMALY_POLICY.minSamples),
    ),
    ewmaAlpha: alpha,
    ewmaLambda: Math.min(alpha, lambda),
    robustZThreshold: clipPositive(
      hit?.robustZThreshold,
      DEFAULT_ANOMALY_POLICY.robustZThreshold,
    ),
    rollingIqrK: clipPositive(
      hit?.rollingIqrK,
      DEFAULT_ANOMALY_POLICY.rollingIqrK,
    ),
    staleMs: Math.trunc(
      clipPositive(hit?.staleMs, DEFAULT_ANOMALY_POLICY.staleMs),
    ),
    warn: hit?.warn,
    crit: hit?.crit,
    direction: hit?.direction ?? 'above',
  };
}
