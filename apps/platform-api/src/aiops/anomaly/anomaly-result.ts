import { createHash } from 'node:crypto';

export const ANOMALY_WINDOWS = ['5m', '15m', '1h', '24h'] as const;
export type AnomalyWindow = (typeof ANOMALY_WINDOWS)[number];

export const ANOMALY_WINDOW_MS: Record<AnomalyWindow, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

export const ANOMALY_ALGORITHMS = [
  'static_threshold',
  'rolling_baseline',
  'robust_zscore',
  'ewma',
  'change_point',
  'isolation_forest',
  'seasonal_baseline',
] as const;

export type AnomalyAlgorithm = (typeof ANOMALY_ALGORITHMS)[number];

export type AnomalyEvidence = {
  summary: string;
  facts: Record<string, number | string | boolean | null>;
};

export type AnomalyMetadata = {
  evidence: AnomalyEvidence[];
  siteId?: string;
  entityType?: string;
  environment?: string;
  source: AnomalyAlgorithm;
  sampleCount: number;
  thresholdSource?: 'platform_thresholds' | 'policy' | 'default';
  policyId?: string;
  mode?: string;
  stats?: Record<string, number | null>;
};

/**
 * Contrato de anomalía numérica (wave 2). RCA y correlación importan este tipo;
 * no duplicar el nombre en otros módulos.
 */
export type AnomalyResult = {
  id: string;
  tenantId: string;
  entityId: string;
  metricName: string;
  timestamp: string;
  actualValue: number;
  expectedValue: number;
  deviation: number;
  score: number;
  confidence: number;
  algorithm: AnomalyAlgorithm;
  window: AnomalyWindow;
  metadata: AnomalyMetadata;
};

export type AnomaliesDetectedPayload = {
  tenantId: string;
  entityId: string;
  metricName: string;
  detectedAt: string;
  anomalies: AnomalyResult[];
};

export function clip01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return Math.round(value * 1000) / 1000;
}

export function anomalyId(input: {
  tenantId: string;
  entityId: string;
  metricName: string;
  algorithm: AnomalyAlgorithm;
  timestamp: string;
  window: AnomalyWindow;
}): string {
  const digest = createHash('sha256')
    .update(
      [
        input.tenantId,
        input.entityId,
        input.metricName,
        input.algorithm,
        input.window,
        input.timestamp,
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 24);
  return `ano_${digest}`;
}

export function createAnomalyResult(
  input: Omit<AnomalyResult, 'id' | 'score' | 'confidence' | 'deviation'> & {
    id?: string;
    score: number;
    confidence: number;
    deviation?: number;
  },
): AnomalyResult {
  const timestamp = input.timestamp;
  const deviation =
    input.deviation ?? Math.abs(input.actualValue - input.expectedValue);
  return {
    id:
      input.id ??
      anomalyId({
        tenantId: input.tenantId,
        entityId: input.entityId,
        metricName: input.metricName,
        algorithm: input.algorithm,
        timestamp,
        window: input.window,
      }),
    tenantId: input.tenantId,
    entityId: input.entityId,
    metricName: input.metricName,
    timestamp,
    actualValue: input.actualValue,
    expectedValue: input.expectedValue,
    deviation,
    score: clip01(input.score),
    confidence: clip01(input.confidence),
    algorithm: input.algorithm,
    window: input.window,
    metadata: {
      ...input.metadata,
      source: input.algorithm,
      evidence: input.metadata.evidence.map((item) => ({
        summary: item.summary,
        facts: { ...item.facts },
      })),
    },
  };
}
