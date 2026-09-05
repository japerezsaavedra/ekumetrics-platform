import { Injectable } from '@nestjs/common';
import type { AnomalyDetector, DetectionContext } from '../anomaly-detector';
import type { AnomalyResult, AnomalyWindow } from '../anomaly-result';
import { ANOMALY_WINDOWS, createAnomalyResult } from '../anomaly-result';
import {
  baselinePoints,
  iqr,
  lastPoint,
  mean,
  median,
  percentile,
  sampleConfidence,
  stddev,
  valuesOf,
} from '../stats';

@Injectable()
export class RollingBaselineDetector implements AnomalyDetector {
  readonly algorithm = 'rolling_baseline' as const;
  readonly windows: readonly AnomalyWindow[] = ANOMALY_WINDOWS;

  detect(ctx: DetectionContext): AnomalyResult[] {
    const current = lastPoint(ctx.points);
    if (!current) return [];
    if (ctx.now - current.timestamp > ctx.policy.staleMs) return [];
    const baseline = baselinePoints(ctx.points);
    if (baseline.length < ctx.policy.minSamples) return [];

    const values = valuesOf(baseline);
    const expected = median(values);
    if (expected == null) return [];

    const q1 = percentile(values, 0.25);
    const q3 = percentile(values, 0.75);
    const p05 = percentile(values, 0.05);
    const p95 = percentile(values, 0.95);
    const spread = iqr(values);
    const avg = mean(values);
    const sd = stddev(values);

    if (spread == null) return [];
    if (spread === 0) {
      if (current.value === expected) return [];
      return [
        createAnomalyResult({
          tenantId: ctx.tenantId,
          entityId: ctx.entityId,
          metricName: ctx.metricName,
          timestamp: new Date(current.timestamp).toISOString(),
          actualValue: current.value,
          expectedValue: expected,
          score: 1,
          confidence: sampleConfidence(baseline.length, ctx.policy.minSamples),
          algorithm: this.algorithm,
          window: ctx.window,
          metadata: {
            source: this.algorithm,
            sampleCount: baseline.length,
            siteId: ctx.siteId,
            entityType: ctx.entityType,
            environment: ctx.environment,
            mode: 'flat_break',
            stats: {
              mean: avg,
              median: expected,
              stddev: sd,
              p50: expected,
              p95,
              iqr: spread,
            },
            evidence: [
              {
                summary:
                  'La serie era constante (IQR=0) y el último valor se apartó de esa línea.',
                facts: {
                  median: expected,
                  actual: current.value,
                  iqr: 0,
                  mean: avg,
                  stddev: sd,
                },
              },
            ],
          },
        }),
      ];
    }

    const k = ctx.policy.rollingIqrK;
    const lower = (q1 ?? expected) - k * spread;
    const upper = (q3 ?? expected) + k * spread;
    const extreme = k * 2;
    const farLower = (q1 ?? expected) - extreme * spread;
    const farUpper = (q3 ?? expected) + extreme * spread;
    const outside = current.value < lower || current.value > upper;
    if (!outside) return [];

    let interpol: number;
    if (current.value > upper) {
      interpol = (current.value - upper) / Math.max(farUpper - upper, spread);
    } else {
      interpol = (lower - current.value) / Math.max(lower - farLower, spread);
    }
    const score = Math.min(1, 0.4 + 0.6 * interpol);

    return [
      createAnomalyResult({
        tenantId: ctx.tenantId,
        entityId: ctx.entityId,
        metricName: ctx.metricName,
        timestamp: new Date(current.timestamp).toISOString(),
        actualValue: current.value,
        expectedValue: expected,
        score,
        confidence: sampleConfidence(baseline.length, ctx.policy.minSamples),
        algorithm: this.algorithm,
        window: ctx.window,
        metadata: {
          source: this.algorithm,
          sampleCount: baseline.length,
          siteId: ctx.siteId,
          entityType: ctx.entityType,
          environment: ctx.environment,
          mode: 'tukey',
          stats: {
            mean: avg,
            median: expected,
            stddev: sd,
            p05,
            p50: expected,
            p95,
            iqr: spread,
          },
          evidence: [
            {
              summary:
                'El último valor sale de la cerca de Tukey (mediana/IQR). No se asume distribución normal.',
              facts: {
                median: expected,
                mean: avg,
                stddev: sd,
                q1,
                q3,
                p05,
                p95,
                iqr: spread,
                k,
                lower,
                upper,
              },
            },
          ],
        },
      }),
    ];
  }
}
