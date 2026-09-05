import { Injectable } from '@nestjs/common';
import type { AnomalyDetector, DetectionContext } from '../anomaly-detector';
import type { AnomalyResult, AnomalyWindow } from '../anomaly-result';
import { createAnomalyResult } from '../anomaly-result';
import {
  finitePoints,
  lastPoint,
  mad,
  median,
  robustScale,
  sampleConfidence,
  valuesOf,
} from '../stats';

@Injectable()
export class EWMADetector implements AnomalyDetector {
  readonly algorithm = 'ewma' as const;
  readonly windows: readonly AnomalyWindow[] = ['1h', '24h'];

  detect(ctx: DetectionContext): AnomalyResult[] {
    const points = finitePoints(ctx.points);
    const current = lastPoint(points);
    if (!current) return [];
    if (ctx.now - current.timestamp > ctx.policy.staleMs) return [];
    if (points.length < Math.max(ctx.policy.minSamples, 12)) return [];

    const alpha = ctx.policy.ewmaAlpha;
    const lambda = ctx.policy.ewmaLambda;
    let fast = points[0].value;
    let slow = points[0].value;
    let residualEwma = 0;
    for (let i = 1; i < points.length; i += 1) {
      const value = points[i].value;
      residualEwma = alpha * Math.abs(value - fast) + (1 - alpha) * residualEwma;
      fast = alpha * value + (1 - alpha) * fast;
      slow = lambda * value + (1 - lambda) * slow;
    }

    const quarter = Math.max(4, Math.floor(points.length / 4));
    const head = valuesOf(points.slice(0, quarter));
    const tail = valuesOf(points.slice(-quarter));
    const headMedian = median(head);
    const tailMedian = median(tail);
    const headScale = robustScale(head) ?? mad(head) ?? 0;
    const levelShift =
      headMedian != null && tailMedian != null
        ? Math.abs(tailMedian - headMedian)
        : 0;
    const relativeShift =
      headMedian != null && Math.abs(headMedian) > 1e-9
        ? levelShift / Math.abs(headMedian)
        : levelShift;
    const scaleShift = Math.max(headScale, Math.abs(headMedian ?? 0) * 0.05, 1e-9);
    const driftScore = Math.min(
      1,
      Math.max(levelShift / (4 * scaleShift), relativeShift / 0.25),
    );
    const residual = Math.abs(current.value - fast);
    const spikeScale = Math.max(residualEwma, 1e-9);
    const spikeScore =
      residual >= 4 * spikeScale ? Math.min(1, residual / (8 * spikeScale)) : 0;
    const mode = driftScore >= spikeScore ? 'drift' : 'spike';
    const score = Math.max(driftScore, spikeScore);
    if (score < ctx.policy.minScore) return [];

    const expected = mode === 'drift' ? (headMedian ?? slow) : fast;
    return [
      createAnomalyResult({
        tenantId: ctx.tenantId,
        entityId: ctx.entityId,
        metricName: ctx.metricName,
        timestamp: new Date(current.timestamp).toISOString(),
        actualValue: current.value,
        expectedValue: expected,
        score,
        confidence: sampleConfidence(points.length, ctx.policy.minSamples),
        algorithm: this.algorithm,
        window: ctx.window,
        metadata: {
          source: this.algorithm,
          sampleCount: points.length,
          siteId: ctx.siteId,
          entityType: ctx.entityType,
          environment: ctx.environment,
          mode,
          policyId: ctx.policy.policyId,
          stats: {
            fastEwma: fast,
            slowEwma: slow,
            alpha,
            lambda,
            residualEwma,
            headMedian,
            tailMedian,
            levelShift,
            relativeShift,
          },
          evidence: [
            {
              summary:
                mode === 'drift'
                  ? `Deriva gradual: mediana inicial ${headMedian} vs reciente ${tailMedian} (EWMA alpha=${alpha}, lambda=${lambda}).`
                  : `Residuo EWMA ${residual.toFixed(4)} vs escala ${spikeScale.toFixed(4)} (alpha=${alpha}).`,
              facts: {
                alpha,
                lambda,
                fastEwma: fast,
                slowEwma: slow,
                residual,
                headMedian,
                tailMedian,
                levelShift,
                relativeShift,
                mode,
              },
            },
          ],
        },
      }),
    ];
  }
}
