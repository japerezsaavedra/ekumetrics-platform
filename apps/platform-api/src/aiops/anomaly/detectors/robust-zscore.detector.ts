import { Injectable } from '@nestjs/common';
import type { AnomalyDetector, DetectionContext } from '../anomaly-detector';
import type { AnomalyResult, AnomalyWindow } from '../anomaly-result';
import { createAnomalyResult } from '../anomaly-result';
import {
  baselinePoints,
  lastPoint,
  mad,
  median,
  sampleConfidence,
  valuesOf,
} from '../stats';

const MAD_TO_Z = 0.6745;

@Injectable()
export class RobustZScoreDetector implements AnomalyDetector {
  readonly algorithm = 'robust_zscore' as const;
  readonly windows: readonly AnomalyWindow[] = ['15m', '1h'];

  detect(ctx: DetectionContext): AnomalyResult[] {
    const current = lastPoint(ctx.points);
    if (!current) return [];
    if (ctx.now - current.timestamp > ctx.policy.staleMs) return [];
    const baseline = baselinePoints(ctx.points);
    if (baseline.length < ctx.policy.minSamples) return [];

    const values = valuesOf(baseline);
    const center = median(values);
    if (center == null) return [];
    const spread = mad(values, center);
    if (spread == null) return [];

    if (spread === 0) {
      if (current.value === center) return [];
      return [
        createAnomalyResult({
          tenantId: ctx.tenantId,
          entityId: ctx.entityId,
          metricName: ctx.metricName,
          timestamp: new Date(current.timestamp).toISOString(),
          actualValue: current.value,
          expectedValue: center,
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
            mode: 'zero_mad_break',
            stats: { median: center, mad: 0 },
            evidence: [
              {
                summary:
                  'MAD=0 (serie plana). El último valor rompe la mediana; no se usa z gaussiano.',
                facts: { median: center, mad: 0, actual: current.value },
              },
            ],
          },
        }),
      ];
    }

    const z = (MAD_TO_Z * (current.value - center)) / spread;
    const absZ = Math.abs(z);
    if (absZ < ctx.policy.robustZThreshold) return [];
    const score = Math.min(1, absZ / 6);

    return [
      createAnomalyResult({
        tenantId: ctx.tenantId,
        entityId: ctx.entityId,
        metricName: ctx.metricName,
        timestamp: new Date(current.timestamp).toISOString(),
        actualValue: current.value,
        expectedValue: center,
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
          mode: 'modified_z',
          stats: { median: center, mad: spread, modifiedZ: z },
          evidence: [
            {
              summary:
                'Z-score modificado (mediana + MAD, Iglewicz-Hoaglin). Escala 0..1 con |z|/6.',
              facts: {
                median: center,
                mad: spread,
                modifiedZ: z,
                threshold: ctx.policy.robustZThreshold,
              },
            },
          ],
        },
      }),
    ];
  }
}
