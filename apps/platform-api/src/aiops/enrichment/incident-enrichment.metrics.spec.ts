import { IncidentEnrichmentMetrics } from './incident-enrichment.metrics';

describe('IncidentEnrichmentMetrics', () => {
  it('expone aiops_incident_enrichment_duration_seconds', () => {
    const metrics = new IncidentEnrichmentMetrics();
    metrics.record(0.2, 'ok');
    metrics.record(0.01, 'missing');
    const output = metrics.render();
    expect(output).toContain(
      '# TYPE aiops_incident_enrichment_duration_seconds histogram',
    );
    expect(output).toContain('aiops_incident_enrichment_duration_seconds_count 2');
    expect(output).toContain(
      'aiops_incident_enrichments_total{outcome="ok"} 1',
    );
    expect(output).toContain(
      'aiops_incident_enrichments_total{outcome="missing"} 1',
    );
    metrics.recordUpdate();
    metrics.recordRcaPersisted();
    expect(metrics.render()).toContain('aiops_enrichment_updates_total 1');
    expect(metrics.render()).toContain('aiops_rca_results_persisted_total 1');
  });
});
