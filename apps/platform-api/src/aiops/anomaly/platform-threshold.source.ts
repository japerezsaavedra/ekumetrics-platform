import type { PlatformThresholds } from '../../platform/platform-thresholds';
import {
  DEFAULT_PLATFORM_THRESHOLDS,
  mergePlatformThresholds,
} from '../../platform/platform-thresholds';

export const PLATFORM_THRESHOLD_SOURCE = Symbol('PLATFORM_THRESHOLD_SOURCE');

export interface PlatformThresholdSource {
  getForTenant(tenantId: string): Promise<PlatformThresholds>;
}

export class InMemoryPlatformThresholdSource implements PlatformThresholdSource {
  private readonly byTenant = new Map<string, PlatformThresholds>();

  set(tenantId: string, values: Partial<PlatformThresholds>): void {
    this.byTenant.set(tenantId, mergePlatformThresholds(values));
  }

  getForTenant(tenantId: string): Promise<PlatformThresholds> {
    return Promise.resolve(
      this.byTenant.get(tenantId) ?? { ...DEFAULT_PLATFORM_THRESHOLDS },
    );
  }
}

type ThresholdPair = {
  warn: keyof PlatformThresholds;
  crit: keyof PlatformThresholds;
};

const METRIC_RULES: Array<{ pattern: RegExp; pair: ThresholdPair }> = [
  { pattern: /error[_-]?budget/, pair: { warn: 'errorBudgetWarn', crit: 'errorBudgetCrit' } },
  { pattern: /avail/, pair: { warn: 'availabilityWarn', crit: 'availabilityCrit' } },
  { pattern: /fresh/, pair: { warn: 'freshnessWarn', crit: 'freshnessCrit' } },
  { pattern: /saturat/, pair: { warn: 'saturationWarn', crit: 'saturationCrit' } },
  { pattern: /p95/, pair: { warn: 'p95Warn', crit: 'p95Crit' } },
  { pattern: /latency/, pair: { warn: 'latencyWarn', crit: 'latencyCrit' } },
  { pattern: /error/, pair: { warn: 'errorsWarn', crit: 'errorsCrit' } },
  { pattern: /cpu/, pair: { warn: 'cpuWarn', crit: 'cpuCrit' } },
  { pattern: /mem/, pair: { warn: 'memWarn', crit: 'memCrit' } },
  { pattern: /disk/, pair: { warn: 'diskWarn', crit: 'diskCrit' } },
  { pattern: /net/, pair: { warn: 'netWarn', crit: 'netCrit' } },
];

export function mapMetricToThresholdKeys(
  metricName: string,
): ThresholdPair | null {
  const name = metricName.trim().toLowerCase();
  if (!name) return null;
  const hit = METRIC_RULES.find((rule) => rule.pattern.test(name));
  return hit?.pair ?? null;
}
