jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('expone contadores, histograma y frescura sin datos personales', async () => {
    const prisma = {
      agent: {
        count: jest
          .fn()
          .mockResolvedValueOnce(4)
          .mockResolvedValueOnce(3)
          .mockResolvedValueOnce(4),
      },
      agentEvent: {
        findFirst: jest.fn().mockResolvedValue({ receivedAt: new Date() }),
      },
    };
    const service = new MetricsService(prisma as never);
    service.observe('get', '/dashboard/:id', 200, 0.12);
    const output = await service.render();

    expect(output).toContain(
      'ekumetrics_http_requests_total{method="GET",route="/dashboard/:id",status_code="200"} 1',
    );
    expect(output).toContain(
      'ekumetrics_http_request_duration_seconds_bucket{method="GET",route="/dashboard/:id",status_code="200",le="0.25"} 1',
    );
    expect(output).toContain('ekumetrics_agents_total 4');
    expect(output).toContain('ekumetrics_agents_fresh{window="5m"} 3');
  });

  it('incluye series de módulos registrados (correlación AIOps)', async () => {
    const prisma = {
      agent: { count: jest.fn().mockResolvedValue(0) },
      agentEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new MetricsService(prisma as never);
    service.registerContributor(
      'aiops-correlation',
      () =>
        '# TYPE aiops_correlations_total counter\naiops_correlations_total{outcome="empty"} 1\n',
    );
    const output = await service.render();
    expect(output).toContain('aiops_correlations_total{outcome="empty"} 1');
  });
});
