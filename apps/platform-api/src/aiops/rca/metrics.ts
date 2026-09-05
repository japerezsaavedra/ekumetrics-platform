import { Injectable } from '@nestjs/common';

const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const CONFIDENCE_BUCKETS = [0.1, 0.25, 0.5, 0.75, 0.9, 1];

type CompletedOutcome = 'ok' | 'empty' | 'error';

/**
 * Series Prometheus de RCA (mismo patrón que CorrelationMetrics).
 * aiops_rca_requests_total, aiops_rca_completed_total,
 * aiops_rca_duration_seconds, aiops_rca_confidence.
 */
@Injectable()
export class RcaMetrics {
  private requests = 0;
  private durationCount = 0;
  private durationSum = 0;
  private readonly durationBuckets = DURATION_BUCKETS.map(() => 0);
  private confidenceCount = 0;
  private confidenceSum = 0;
  private readonly confidenceBuckets = CONFIDENCE_BUCKETS.map(() => 0);
  private readonly completed = new Map<CompletedOutcome, number>([
    ['ok', 0],
    ['empty', 0],
    ['error', 0],
  ]);

  recordRequest(): void {
    this.requests += 1;
  }

  recordCompleted(
    durationSeconds: number,
    outcome: CompletedOutcome,
    leadingConfidence?: number,
  ): void {
    const seconds = Math.max(0, durationSeconds);
    this.durationCount += 1;
    this.durationSum += seconds;
    DURATION_BUCKETS.forEach((bucket, index) => {
      if (seconds <= bucket) this.durationBuckets[index] += 1;
    });
    this.completed.set(outcome, (this.completed.get(outcome) ?? 0) + 1);
    if (leadingConfidence == null || !Number.isFinite(leadingConfidence)) {
      return;
    }
    const confidence = Math.min(1, Math.max(0, leadingConfidence));
    this.confidenceCount += 1;
    this.confidenceSum += confidence;
    CONFIDENCE_BUCKETS.forEach((bucket, index) => {
      if (confidence <= bucket) this.confidenceBuckets[index] += 1;
    });
  }

  render(): string {
    const lines = [
      '# HELP aiops_rca_requests_total Solicitudes de RCA determinista.',
      '# TYPE aiops_rca_requests_total counter',
      `aiops_rca_requests_total ${this.requests}`,
      '# HELP aiops_rca_completed_total Ejecuciones de RCA terminadas.',
      '# TYPE aiops_rca_completed_total counter',
    ];
    for (const outcome of ['ok', 'empty', 'error'] as const) {
      lines.push(
        `aiops_rca_completed_total{outcome="${outcome}"} ${this.completed.get(outcome) ?? 0}`,
      );
    }
    lines.push(
      '# HELP aiops_rca_duration_seconds Duración de una pasada de RCA.',
      '# TYPE aiops_rca_duration_seconds histogram',
    );
    DURATION_BUCKETS.forEach((bucket, index) => {
      lines.push(
        `aiops_rca_duration_seconds_bucket{le="${bucket}"} ${this.durationBuckets[index]}`,
      );
    });
    lines.push(
      `aiops_rca_duration_seconds_bucket{le="+Inf"} ${this.durationCount}`,
      `aiops_rca_duration_seconds_sum ${this.durationSum}`,
      `aiops_rca_duration_seconds_count ${this.durationCount}`,
      '# HELP aiops_rca_confidence Confianza del candidato RCA principal.',
      '# TYPE aiops_rca_confidence histogram',
    );
    CONFIDENCE_BUCKETS.forEach((bucket, index) => {
      lines.push(
        `aiops_rca_confidence_bucket{le="${bucket}"} ${this.confidenceBuckets[index]}`,
      );
    });
    lines.push(
      `aiops_rca_confidence_bucket{le="+Inf"} ${this.confidenceCount}`,
      `aiops_rca_confidence_sum ${this.confidenceSum}`,
      `aiops_rca_confidence_count ${this.confidenceCount}`,
    );
    return `${lines.join('\n')}\n`;
  }
}
