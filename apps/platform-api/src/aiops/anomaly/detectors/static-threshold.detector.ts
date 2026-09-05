import { Injectable } from '@nestjs/common';
import type { AnomalyDetector, DetectionContext } from '../anomaly-detector';
import type { AnomalyResult, AnomalyWindow } from '../anomaly-result';
import { createAnomalyResult } from '../anomaly-result';
import { lastPoint, sampleConfidence } from '../stats';
import { mapMetricToThresholdKeys } from '../platform-threshold.source';

@Injectable()
export class StaticThresholdDetector implements AnomalyDetector {
  readonly algorithm = 'static_threshold' as const;
  readonly windows: readonly AnomalyWindow[] = ['5m'];

  detect(ctx: DetectionContext): AnomalyResult[] {
    const current = lastPoint(ctx.points);
    if (!current) return [];
    if (ctx.now - current.timestamp > ctx.policy.staleMs) return [];

    const mapped = mapMetricToThresholdKeys(ctx.metricName);
    const warn = ctx.policy.warn ?? (mapped ? ctx.thresholds[mapped.warn] : undefined);
    const crit = ctx.policy.crit ?? (mapped ? ctx.thresholds[mapped.crit] : undefined);
    if (warn == null || crit == null || !Number.isFinite(warn) || !Number.isFinite(crit)) {
      return [];
    }

    const direction = ctx.policy.direction;
    const thresholdSource: 'policy' | 'platform_thresholds' =
      ctx.policy.warn != null || ctx.policy.crit != null
        ? 'policy'
        : 'platform_thresholds';

    const breached = direction === 'below' ? current.value <= warn : current.value >= warn;
    if (!breached) return [];

    const expectedValue = warn;
    const span = Math.abs(crit - warn) || 1;
    let interpol: number;
    if (direction === 'below') {
      interpol = current.value <= crit ? 1 : (warn - current.value) / span;
    } else {
      interpol = current.value >= crit ? 1 : (current.value - warn) / span;
    }
    const score = 0.5 + 0.5 * Math.min(1, Math.max(0, interpol));

    return [
      createAnomalyResult({
        tenantId: ctx.tenantId,
        entityId: ctx.entityId,
        metricName: ctx.metricName,
        timestamp: new Date(current.timestamp).toISOString(),
        actualValue: current.value,
        expectedValue,
        score,
        confidence: Math.max(0.6, sampleConfidence(ctx.points.length, 1)),
        algorithm: this.algorithm,
        window: ctx.window,
        metadata: {
          source: this.algorithm,
          sampleCount: ctx.points.length,
          thresholdSource,
          policyId: ctx.policy.policyId,
          siteId: ctx.siteId,
          entityType: ctx.entityType,
          environment: ctx.environment,
          stats: { warn, crit },
          evidence: [
            {
              summary:
                direction === 'below'
                  ? `Valor ${current.value} por debajo del umbral de aviso ${warn} (crítico ${crit}).`
                  : `Valor ${current.value} por encima del umbral de aviso ${warn} (crítico ${crit}).`,
              facts: {
                warn,
                crit,
                direction,
                thresholdSource,
                platformKeys: mapped
                  ? `${mapped.warn}/${mapped.crit}`
                  : 'policy',
              },
            },
          ],
        },
      }),
    ];
  }
}
