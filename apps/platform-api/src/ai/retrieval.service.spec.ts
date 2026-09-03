jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RetrievalService, type RetrievalMetric } from './retrieval.service';

describe('RetrievalService', () => {
  let rangeInput: { query: string; seconds: number; step: number } | undefined;
  let lokiQuery: string | undefined;
  let tempoInput:
    | { query: string; seconds: number; limit: number; spans: number }
    | undefined;
  const telemetry = {
    instant: jest.fn(),
    range: jest.fn(),
    lokiLines: jest.fn(),
    tempoSearch: jest.fn(),
    first: jest.fn((rows: Array<{ value: number }>) => rows[0]?.value ?? null),
  };
  const dashboard = { getInventory: jest.fn() };
  const knowledge = { search: jest.fn() };
  const prisma = {
    tenant: { findUnique: jest.fn() },
    agent: { findUnique: jest.fn() },
    asset: { findMany: jest.fn() },
    agentEvent: { findMany: jest.fn() },
    incident: { findMany: jest.fn() },
  };
  const service = new RetrievalService(
    telemetry as never,
    dashboard as never,
    prisma as never,
    knowledge as never,
  );
  const context = {
    tenantSlug: 'tenant-a',
    actor: 'user@example.com',
    agentId: 'shared-agent',
    siteId: 'site-a',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    rangeInput = undefined;
    lokiQuery = undefined;
    tempoInput = undefined;
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-db-a',
      slug: 'tenant-a',
    });
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-db-a',
      agentId: 'shared-agent',
      siteId: 'site-a',
    });
    telemetry.range.mockImplementation(
      (query: string, seconds: number, step: number) => {
        rangeInput = { query, seconds, step };
        return Promise.resolve([]);
      },
    );
    telemetry.instant.mockResolvedValue([]);
    telemetry.lokiLines.mockImplementation((query: string) => {
      lokiQuery = query;
      return Promise.resolve([]);
    });
    telemetry.tempoSearch.mockImplementation(
      (query: string, seconds: number, limit: number, spans: number) => {
        tempoInput = { query, seconds, limit, spans };
        return Promise.resolve([]);
      },
    );
  });

  it('construye PromQL solo desde el catalogo y las tres dimensiones autorizadas', async () => {
    await service.getMetricSeries(context, 'cpu_used_ratio', 60);

    const query = rangeInput?.query ?? '';
    expect(query).toContain('tenant_id="tenant-a"');
    expect(query).toContain('site_id="site-a"');
    expect(query).toContain('agent_id="shared-agent"');
    expect(rangeInput?.seconds).toBe(3600);
    const result = await service.getMetricSeries(context, 'load_1m', 15);
    const evidence = result.evidence[0];
    expect(evidence?.source).toBe('prometheus');
    expect(evidence?.operation).toBe('get_metric_series:load_1m');
    expect(typeof evidence?.window.start).toBe('string');
    expect(typeof evidence?.window.end).toBe('string');
  });

  it('rechaza nombres de metrica que intenten introducir PromQL', async () => {
    await expect(
      service.getMetricSeries(
        context,
        'up or vector(1)' as RetrievalMetric,
        60,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(telemetry.range).not.toHaveBeenCalled();
  });

  it('rechaza ventanas superiores a 24 horas', async () => {
    await expect(
      service.getMetricSeries(context, 'cpu_used_ratio', 1441),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza un agente que no pertenece al tenant antes de consultar fuentes', async () => {
    prisma.agent.findUnique.mockResolvedValue(null);

    await expect(service.getHostHealth(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(telemetry.instant).not.toHaveBeenCalled();
  });

  it('filtra eventos en PostgreSQL por tenant, agente, ventana y limite', async () => {
    type EventFindInput = {
      where: { tenantId: string; agentId?: string };
      take: number;
    };
    let eventInput: EventFindInput | undefined;
    prisma.agentEvent.findMany.mockImplementation((input: EventFindInput) => {
      eventInput = input;
      return Promise.resolve([]);
    });

    await service.getAgentEvents(context, 30, 25);

    expect(eventInput?.where.tenantId).toBe('tenant-db-a');
    expect(eventInput?.where.agentId).toBe('agent-db-a');
    expect(eventInput?.take).toBe(25);
  });

  it('no incorpora el texto buscado a LogQL y redacta secretos', async () => {
    telemetry.lokiLines.mockImplementation((query: string) => {
      lokiQuery = query;
      return Promise.resolve([
        {
          ts: 1,
          line: 'error |~ ".*" password=super-secret token=abc123',
          fields: {},
        },
      ]);
    });

    const result = await service.searchLogs(context, 'error |~ ".*"', 15, 10);

    const query = lokiQuery ?? '';
    expect(query).not.toContain('|~');
    expect(query).toContain('tenant_id="tenant-a"');
    expect(result.data[0]?.line).toContain('[REDACTED]');
    expect(result.data[0]?.line).not.toContain('super-secret');
  });

  it('construye TraceQL acotado por tenant, sitio, agente y tiempo', async () => {
    const result = await service.searchTraces(context, 30, 10, 500, true);

    expect(tempoInput?.query).toContain('resource.tenant.id = "tenant-a"');
    expect(tempoInput?.query).toContain('resource.host.site = "site-a"');
    expect(tempoInput?.query).toContain('resource.agent.id = "shared-agent"');
    expect(tempoInput?.query).toContain('trace:duration > 500ms');
    expect(tempoInput?.query).toContain('span:status = error');
    expect(tempoInput).toMatchObject({ seconds: 1800, limit: 10, spans: 3 });
    expect(result.evidence[0]?.source).toBe('tempo');
  });

  it('correlaciona solo logs cuyo trace_id pertenece a las trazas autorizadas', async () => {
    telemetry.tempoSearch.mockResolvedValue([
      {
        traceId: '0123456789abcdef0123456789abcdef',
        rootServiceName: 'api',
        rootTraceName: 'GET /orders',
        startTimeUnixNano: '1',
        durationMs: 800,
        spans: [],
      },
    ]);
    telemetry.lokiLines.mockResolvedValue([
      {
        ts: 1,
        line: 'matched password=secret',
        fields: { trace_id: '0123456789abcdef0123456789abcdef' },
      },
      {
        ts: 2,
        line: 'foreign',
        fields: { trace_id: 'ffffffffffffffffffffffffffffffff' },
      },
    ]);

    const result = await service.searchTraces(context);

    expect(result.data.correlatedLogs).toHaveLength(1);
    expect(result.data.correlatedLogs[0]?.line).toContain('[REDACTED]');
    expect(result.evidence.map((item) => item.source)).toEqual([
      'tempo',
      'loki',
    ]);
    expect(result.evidence[0]?.references?.[0]).toMatchObject({
      traceId: '0123456789abcdef0123456789abcdef',
      service: 'api',
      operation: 'GET /orders',
      durationMs: 800,
    });
  });

  it('rechaza limites y ventanas de trazas fuera de politica', async () => {
    await expect(service.searchTraces(context, 1441)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.searchTraces(context, 60, 21)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(telemetry.tempoSearch).not.toHaveBeenCalled();
  });
});
