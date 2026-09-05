import { Injectable } from '@nestjs/common';

const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

type Outcome = 'created' | 'updated' | 'empty';

/**
 * Histograma y contador al estilo MetricsService de platform-api.
 * Series: aiops_correlation_duration_seconds, aiops_correlations_total.
 */
@Injectable()
export class CorrelationMetrics {
  private durationCount = 0;
  private durationSum = 0;
  private readonly durationBuckets = DURATION_BUCKETS.map(() => 0);
  private readonly totals = new Map<Outcome, number>([
    ['created', 0],
    ['updated', 0],
    ['empty', 0],
  ]);

  record(durationSeconds: number, created: number, updated: number): void {
    const seconds = Math.max(0, durationSeconds);
    this.durationCount += 1;
    this.durationSum += seconds;
    DURATION_BUCKETS.forEach((bucket, index) => {
      if (seconds <= bucket) this.durationBuckets[index] += 1;
    });
    if (created === 0 && updated === 0) {
      this.bump('empty', 1);
      return;
    }
    if (created > 0) this.bump('created', created);
    if (updated > 0) this.bump('updated', updated);
  }

  render(): string {
    const lines = [
      '# HELP aiops_correlation_duration_seconds Duración de una pasada de correlación AIOps.',
      '# TYPE aiops_correlation_duration_seconds histogram',
    ];
    DURATION_BUCKETS.forEach((bucket, index) => {
      lines.push(
        `aiops_correlation_duration_seconds_bucket{le="${bucket}"} ${this.durationBuckets[index]}`,
      );
    });
    lines.push(
      `aiops_correlation_duration_seconds_bucket{le="+Inf"} ${this.durationCount}`,
      `aiops_correlation_duration_seconds_sum ${this.durationSum}`,
      `aiops_correlation_duration_seconds_count ${this.durationCount}`,
      '# HELP aiops_correlations_total Clusters de correlación procesados.',
      '# TYPE aiops_correlations_total counter',
    );
    for (const outcome of ['created', 'updated', 'empty'] as const) {
      lines.push(
        `aiops_correlations_total{outcome="${outcome}"} ${this.totals.get(outcome) ?? 0}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }

  private bump(outcome: Outcome, amount: number) {
    this.totals.set(outcome, (this.totals.get(outcome) ?? 0) + amount);
  }
}
