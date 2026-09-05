import { HistoricalMetrics } from './historical.metrics';

describe('HistoricalMetrics', () => {
  it('expone contadores de lookup y feedback', () => {
    const metrics = new HistoricalMetrics();
    metrics.recordLookup(false);
    metrics.recordLookup(true);
    metrics.recordFeedback('CONFIRM');
    const output = metrics.render();
    expect(output).toContain(
      'aiops_historical_lookups_total{outcome="neutral"} 1',
    );
    expect(output).toContain(
      'aiops_historical_lookups_total{outcome="matched"} 1',
    );
    expect(output).toContain(
      'aiops_rca_feedback_total{action="CONFIRM"} 1',
    );
    expect(output).toContain('aiops_feedback_total{action="CONFIRM"} 1');
  });
});
