import { CorrelationMetrics } from './correlation-metrics';

describe('CorrelationMetrics', () => {
  it('expone histograma y contador al estilo Prometheus de platform-api', () => {
    const metrics = new CorrelationMetrics();
    metrics.record(0.12, 2, 1);
    metrics.record(0.01, 0, 0);
    const output = metrics.render();

    expect(output).toContain(
      '# TYPE aiops_correlation_duration_seconds histogram',
    );
    expect(output).toContain(
      'aiops_correlation_duration_seconds_bucket{le="0.25"} 2',
    );
    expect(output).toContain('aiops_correlation_duration_seconds_count 2');
    expect(output).toContain('# TYPE aiops_correlations_total counter');
    expect(output).toContain('aiops_correlations_total{outcome="created"} 2');
    expect(output).toContain('aiops_correlations_total{outcome="updated"} 1');
    expect(output).toContain('aiops_correlations_total{outcome="empty"} 1');
  });
});
