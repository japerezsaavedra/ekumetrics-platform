import { Injectable } from '@nestjs/common';

const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

type Outcome = 'ok' | 'missing' | 'error';

/**
 * Histograma Prometheus: aiops_incident_enrichment_duration_seconds.
 */
@Injectable()
export class IncidentEnrichmentMetrics {
  private durationCount = 0;
  private durationSum = 0;
  private readonly durationBuckets = DURATION_BUCKETS.map(() => 0);
  private readonly totals = new Map<Outcome, number>([
    ['ok', 0],
    ['missing', 0],
    ['error', 0],
  ]);
  private updates = 0;
  private rcaPersisted = 0;

  record(durationSeconds: number, outcome: Outcome): void {
    const seconds = Math.max(0, durationSeconds);
    this.durationCount += 1;
    this.durationSum += seconds;
    DURATION_BUCKETS.forEach((bucket, index) => {
      if (seconds <= bucket) this.durationBuckets[index] += 1;
    });
    this.totals.set(outcome, (this.totals.get(outcome) ?? 0) + 1);
  }

  recordUpdate(): void {
    this.updates += 1;
  }

  recordRcaPersisted(): void {
    this.rcaPersisted += 1;
  }

  render(): string {
    const lines = [
      '# HELP aiops_incident_enrichment_duration_seconds Duracion del enriquecimiento asincrono de un incidente AIOps.',
      '# TYPE aiops_incident_enrichment_duration_seconds histogram',
    ];
    DURATION_BUCKETS.forEach((bucket, index) => {
      lines.push(
        `aiops_incident_enrichment_duration_seconds_bucket{le="${bucket}"} ${this.durationBuckets[index]}`,
      );
    });
    lines.push(
      `aiops_incident_enrichment_duration_seconds_bucket{le="+Inf"} ${this.durationCount}`,
      `aiops_incident_enrichment_duration_seconds_sum ${this.durationSum}`,
      `aiops_incident_enrichment_duration_seconds_count ${this.durationCount}`,
      '# HELP aiops_incident_enrichments_total Pasadas de enriquecimiento de incidentes.',
      '# TYPE aiops_incident_enrichments_total counter',
    );
    for (const outcome of ['ok', 'missing', 'error'] as const) {
      lines.push(
        `aiops_incident_enrichments_total{outcome="${outcome}"} ${this.totals.get(outcome) ?? 0}`,
      );
    }
    lines.push(
      '# HELP aiops_enrichment_updates_total Actualizaciones persistidas de IncidentEnrichment.',
      '# TYPE aiops_enrichment_updates_total counter',
      `aiops_enrichment_updates_total ${this.updates}`,
      '# HELP aiops_rca_results_persisted_total Resultados de RcaEngine persistidos en enrichment.',
      '# TYPE aiops_rca_results_persisted_total counter',
      `aiops_rca_results_persisted_total ${this.rcaPersisted}`,
    );
    return `${lines.join('\n')}\n`;
  }
}
