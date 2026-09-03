export type PlatformThresholds = {
  availabilityWarn: number;
  availabilityCrit: number;
  errorBudgetWarn: number;
  errorBudgetCrit: number;
  latencyWarn: number;
  latencyCrit: number;
  freshnessWarn: number;
  freshnessCrit: number;
  saturationWarn: number;
  saturationCrit: number;
  cpuWarn: number;
  cpuCrit: number;
  memWarn: number;
  memCrit: number;
  diskWarn: number;
  diskCrit: number;
  netWarn: number;
  netCrit: number;
  errorsWarn: number;
  errorsCrit: number;
  p95Warn: number;
  p95Crit: number;
};

export const DEFAULT_PLATFORM_THRESHOLDS: PlatformThresholds = {
  availabilityWarn: 0.01,
  availabilityCrit: 0.05,
  errorBudgetWarn: 0.5,
  errorBudgetCrit: 1,
  latencyWarn: 0.05,
  latencyCrit: 0.15,
  freshnessWarn: 0.01,
  freshnessCrit: 0.05,
  saturationWarn: 0.8,
  saturationCrit: 1,
  cpuWarn: 0.7,
  cpuCrit: 0.9,
  memWarn: 0.8,
  memCrit: 0.9,
  diskWarn: 0.7,
  diskCrit: 0.85,
  netWarn: 0.1,
  netCrit: 1,
  errorsWarn: 0.01,
  errorsCrit: 0.05,
  p95Warn: 0.5,
  p95Crit: 1,
};

const KEYS = Object.keys(DEFAULT_PLATFORM_THRESHOLDS) as (keyof PlatformThresholds)[];

export function mergePlatformThresholds(raw: unknown): PlatformThresholds {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const next = { ...DEFAULT_PLATFORM_THRESHOLDS };
  for (const key of KEYS) {
    const value = Number(src[key]);
    if (Number.isFinite(value) && value >= 0) {
      next[key] = value;
    }
  }
  return next;
}
