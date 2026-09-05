import { RcaMetrics } from './metrics';

describe('RcaMetrics', () => {
  it('expone las series aiops_rca_* pedidas', () => {
    const metrics = new RcaMetrics();
    metrics.recordRequest();
    metrics.recordRequest();
    metrics.recordCompleted(0.12, 'ok', 0.91);
    metrics.recordCompleted(0.01, 'empty');
    const output = metrics.render();
    expect(output).toContain('# TYPE aiops_rca_requests_total counter');
    expect(output).toContain('aiops_rca_requests_total 2');
    expect(output).toContain('# TYPE aiops_rca_completed_total counter');
    expect(output).toContain('aiops_rca_completed_total{outcome="ok"} 1');
    expect(output).toContain('aiops_rca_completed_total{outcome="empty"} 1');
    expect(output).toContain('# TYPE aiops_rca_duration_seconds histogram');
    expect(output).toContain('aiops_rca_duration_seconds_count 2');
    expect(output).toContain('# TYPE aiops_rca_confidence histogram');
    expect(output).toContain('aiops_rca_confidence_count 1');
  });
});
