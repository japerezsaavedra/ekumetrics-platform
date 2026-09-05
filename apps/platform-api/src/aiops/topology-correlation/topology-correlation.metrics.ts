import { Injectable } from '@nestjs/common';

/**
 * Contadores Prometheus de correlación topológica (Wave 2).
 * Series: aiops_topology_correlations_total, aiops_root_cause_suppressions_total.
 */
@Injectable()
export class TopologyCorrelationMetrics {
  private correlations = 0;
  private suppressions = 0;

  recordCorrelation(amount = 1): void {
    this.correlations += Math.max(0, amount);
  }

  recordSuppression(amount = 1): void {
    this.suppressions += Math.max(0, amount);
  }

  render(): string {
    return [
      '# HELP aiops_topology_correlations_total Clusters enriquecidos con correlación topológica.',
      '# TYPE aiops_topology_correlations_total counter',
      `aiops_topology_correlations_total ${this.correlations}`,
      '# HELP aiops_root_cause_suppressions_total Incidentes independientes de alta prioridad no creados por causa raíz topológica.',
      '# TYPE aiops_root_cause_suppressions_total counter',
      `aiops_root_cause_suppressions_total ${this.suppressions}`,
      '',
    ].join('\n');
  }
}
