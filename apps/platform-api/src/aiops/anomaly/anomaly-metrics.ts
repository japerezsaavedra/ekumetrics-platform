import { Injectable } from '@nestjs/common';
import type { AnomalyAlgorithm } from './anomaly-result';

const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

/**
 * Series Prometheus al estilo CorrelationMetrics:
 * aiops_anomalies_detected_total, aiops_anomaly_detection_duration_seconds.
 */
@Injectable()
export class AnomalyMetrics {
  private durationCount = 0;
  private durationSum = 0;
  private readonly durationBuckets = DURATION_BUCKETS.map(() => 0);
  private readonly totals = new Map<string, number>();
  private persisted = 0;

  record(durationSeconds: number, algorithmCounts: Record<string, number>): void {
    const seconds = Math.max(0, durationSeconds);
    this.durationCount += 1;
    this.durationSum += seconds;
    DURATION_BUCKETS.forEach((bucket, index) => {
      if (seconds <= bucket) this.durationBuckets[index] += 1;
    });
    for (const [algorithm, amount] of Object.entries(algorithmCounts)) {
      if (amount > 0) {
        this.totals.set(algorithm, (this.totals.get(algorithm) ?? 0) + amount);
      }
    }
  }

  recordPersisted(count: number): void {
    if (count > 0) this.persisted += count;
  }

  render(): string {
    const lines = [
      '# HELP aiops_anomaly_detection_duration_seconds Duración de una evaluación de anomalías AIOps.',
      '# TYPE aiops_anomaly_detection_duration_seconds histogram',
    ];
    DURATION_BUCKETS.forEach((bucket, index) => {
      lines.push(
        `aiops_anomaly_detection_duration_seconds_bucket{le="${bucket}"} ${this.durationBuckets[index]}`,
      );
    });
    lines.push(
      `aiops_anomaly_detection_duration_seconds_bucket{le="+Inf"} ${this.durationCount}`,
      `aiops_anomaly_detection_duration_seconds_sum ${this.durationSum}`,
      `aiops_anomaly_detection_duration_seconds_count ${this.durationCount}`,
      '# HELP aiops_anomalies_detected_total Anomalías numéricas publicadas por el AnomalyEngine.',
      '# TYPE aiops_anomalies_detected_total counter',
    );
    const algorithms: AnomalyAlgorithm[] = [
      'static_threshold',
      'rolling_baseline',
      'robust_zscore',
      'ewma',
      'change_point',
      'isolation_forest',
      'seasonal_baseline',
    ];
    for (const algorithm of algorithms) {
      lines.push(
        `aiops_anomalies_detected_total{algorithm="${algorithm}"} ${this.totals.get(algorithm) ?? 0}`,
      );
    }
    lines.push(
      '# HELP aiops_anomaly_persistence_total Anomalías persistidas (PostgreSQL).',
      '# TYPE aiops_anomaly_persistence_total counter',
      `aiops_anomaly_persistence_total ${this.persisted}`,
    );
    return `${lines.join('\n')}\n`;
  }
}
