import type { ExplainableOutput } from './explainable';

export const ANOMALY_DETECTOR_TYPES = [
  'StaticThreshold',
  'RollingBaseline',
  'RobustZScore',
  'EWMA',
] as const;

export type AnomalyDetectorType = (typeof ANOMALY_DETECTOR_TYPES)[number];

/** Valores persistidos / wire (snake_case). StaticThreshold reusa PlatformThresholds. */
export const ANOMALY_ALGORITHMS = [
  'static_threshold',
  'rolling_baseline',
  'robust_zscore',
  'ewma',
] as const;

export type AnomalyAlgorithm = (typeof ANOMALY_ALGORITHMS)[number];

export const DETECTOR_TYPE_TO_ALGORITHM: Record<
  AnomalyDetectorType,
  AnomalyAlgorithm
> = {
  StaticThreshold: 'static_threshold',
  RollingBaseline: 'rolling_baseline',
  RobustZScore: 'robust_zscore',
  EWMA: 'ewma',
};

export function isAnomalyDetectorType(
  value: string,
): value is AnomalyDetectorType {
  return (ANOMALY_DETECTOR_TYPES as readonly string[]).includes(value);
}

export function isAnomalyAlgorithm(value: string): value is AnomalyAlgorithm {
  return (ANOMALY_ALGORITHMS as readonly string[]).includes(value);
}

/**
 * Umbral estático. No copiar PlatformThresholds.values:
 * source=platform_thresholds apunta a slot/claves existentes (cpuWarn, memCrit, …).
 */
export type StaticThresholdConfig = {
  source: 'platform_thresholds' | 'inline';
  platformThresholdsSlot?: string;
  platformThresholdsId?: string;
  warnKey?: string;
  critKey?: string;
  warn?: number;
  crit?: number;
  comparator?: 'gt' | 'gte' | 'lt' | 'lte';
};

export type RollingBaselineConfig = {
  window: string;
  minSamples?: number;
  stddevMultiplier?: number;
};

export type RobustZScoreConfig = {
  window: string;
  threshold: number;
  minSamples?: number;
};

export type EwmaConfig = {
  alpha: number;
  threshold: number;
  warmupSamples?: number;
};

export type AnomalyDetectorConfigMap = {
  StaticThreshold: StaticThresholdConfig;
  RollingBaseline: RollingBaselineConfig;
  RobustZScore: RobustZScoreConfig;
  EWMA: EwmaConfig;
};

export type AiopsAnomalyPolicyTarget = {
  tenantId: string;
  siteId?: string;
  entityType?: string;
  entityId?: string;
  metric?: string;
  environment?: string;
};

export type AiopsAnomalyPolicyRecord = AiopsAnomalyPolicyTarget & {
  id?: string;
  detectorType: AnomalyDetectorType | AnomalyAlgorithm;
  config:
    | StaticThresholdConfig
    | RollingBaselineConfig
    | RobustZScoreConfig
    | EwmaConfig;
  enabled: boolean;
  weight: number;
  platformThresholdsId?: string;
};

export type AnomalySeriesPoint = {
  timestamp: Date;
  value: number;
};

export type AnomalyDetectInput = {
  tenantId: string;
  entityId: string;
  metricName: string;
  values: AnomalySeriesPoint[];
  entityType?: string;
  siteId?: string;
  environment?: string;
  incidentId?: string;
  policy?: AiopsAnomalyPolicyRecord;
};

/** Forma persistible (Prisma AiopsAnomaly). timestamp Date o ISO. */
export type AnomalyResult = {
  id?: string;
  tenantId: string;
  entityId: string;
  metricName: string;
  timestamp: Date | string;
  actualValue: number;
  expectedValue?: number;
  deviation?: number;
  score: number;
  confidence: number;
  algorithm: AnomalyAlgorithm | AnomalyDetectorType | string;
  window?: string;
  metadata?: Record<string, unknown>;
  incidentId?: string;
  explainable?: ExplainableOutput;
};

export interface AnomalyDetector {
  readonly detectorType: AnomalyDetectorType;
  detect(input: AnomalyDetectInput): Promise<AnomalyResult[]>;
}
