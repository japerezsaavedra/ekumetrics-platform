import { createHash } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GRAPH_EXAMPLE_EDGES as edges } from './graph-example';
import { CorrelationMetrics } from './correlation-metrics';
import { CorrelationService, type CorrelateAlert } from './correlation.service';

jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

const TENANT_A = { id: 'tenant-a', slug: 'cliente-a' };
const TENANT_B = { id: 'tenant-b', slug: 'cliente-b' };

function clusterKeyOf(fingerprints: string[]): string {
  return createHash('sha256')
    .update([...fingerprints].sort().join('|'))
    .digest('hex');
}

function alert(
  overrides: Partial<CorrelateAlert> & Pick<CorrelateAlert, 'fingerprint'>,
): CorrelateAlert {
  return {
    name: overrides.name ?? overrides.fingerprint,
    severity: overrides.severity ?? 'warning',
    siteId: overrides.siteId ?? 'santiago',
    nodeHint: overrides.nodeHint,
    startsAt: overrides.startsAt ?? '2026-09-04T12:00:00.000Z',
    labels: overrides.labels,
    fingerprint: overrides.fingerprint,
  };
}

describe('CorrelationService', () => {
  const prisma = {
    tenant: { findUnique: jest.fn() },
    site: { findFirst: jest.fn() },
    incident: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    agentEvent: { findMany: jest.fn() },
  };
  const graph = {
    links: jest.fn(),
    matchNode: jest.fn(),
    nodeByKey: jest.fn(),
    impact: jest.fn(),
    snapshot: jest.fn(),
    seedExample: jest.fn(),
  };
  const alertmanager = { overview: jest.fn() };
  const config = {
    get: jest.fn(() => undefined),
  } as unknown as ConfigService;
  const metrics = new CorrelationMetrics();

  const service = () =>
    new CorrelationService(
      prisma as never,
      graph as never,
      alertmanager as never,
      config,
      metrics,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.tenant.findUnique.mockImplementation(
      ({ where }: { where: { slug: string } }) =>
        [TENANT_A, TENANT_B].find((row) => row.slug === where.slug) ?? null,
    );
    prisma.incident.findFirst.mockResolvedValue(null);
    prisma.incident.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'inc-1', status: 'open', ...data }),
    );
    prisma.incident.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'inc-1', status: 'open', ...data }),
    );
    prisma.incident.count.mockResolvedValue(0);
    prisma.incident.findMany.mockResolvedValue([]);
    prisma.agentEvent.findMany.mockResolvedValue([]);
    graph.links.mockResolvedValue(edges);
    graph.matchNode.mockImplementation(
      (_tenantId: string, _siteId: string | undefined, hint: string) =>
        Promise.resolve(hint ? { nodeKey: hint, name: hint } : null),
    );
    graph.nodeByKey.mockImplementation((_tenantId: string, nodeKey: string) =>
      Promise.resolve(
        nodeKey
          ? { nodeKey, name: nodeKey === 'sw-core' ? 'Core switch' : nodeKey }
          : null,
      ),
    );
  });

  it('devuelve vacío sin crear incidentes si no hay alertas', async () => {
    const result = await service().merge(TENANT_A.id, TENANT_A.slug, []);
    expect(result).toEqual({
      tenant: TENANT_A.slug,
      created: 0,
      updated: 0,
      incidents: [],
    });
    expect(prisma.incident.create).not.toHaveBeenCalled();
  });

  it('agrupa alertas del mismo sitio, ventana y camino (compat V1)', async () => {
    const result = await service().merge(TENANT_A.id, TENANT_A.slug, [
      alert({ fingerprint: 'fp-api', nodeHint: 'api-pagos' }),
      alert({
        fingerprint: 'fp-db',
        nodeHint: 'postgres',
        startsAt: '2026-09-04T12:02:00.000Z',
      }),
      alert({ fingerprint: 'fp-sap', nodeHint: 'sap' }),
    ]);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(prisma.incident.create).toHaveBeenCalledTimes(1);
    const data = prisma.incident.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe(TENANT_A.id);
    expect(data.clusterKey).toBe(clusterKeyOf(['fp-api', 'fp-db', 'fp-sap']));
    expect(data.causeKey).toBe('sw-core');
    expect(data.causeName).toBe('Core switch');
    expect(data.title).toBe('Degradación de conectividad · Core switch');
    expect(data.confidence).toBe(0.85);
    expect(data.members.alerts).toEqual([
      expect.objectContaining({ fingerprint: 'fp-api', nodeHint: 'api-pagos' }),
      expect.objectContaining({ fingerprint: 'fp-db', nodeHint: 'postgres' }),
      expect.objectContaining({ fingerprint: 'fp-sap', nodeHint: 'sap' }),
    ]);
    expect(data.members.impact).toEqual(expect.arrayContaining(['api-pagos']));
  });

  it('no correlaciona sitios distintos', async () => {
    const result = await service().merge(TENANT_A.id, TENANT_A.slug, [
      alert({ fingerprint: 'fp-a', siteId: 'santiago', nodeHint: 'api-pagos' }),
      alert({
        fingerprint: 'fp-b',
        siteId: 'valparaiso',
        nodeHint: 'postgres',
      }),
    ]);
    expect(result.created).toBe(2);
  });

  it('no correlaciona fuera de la ventana de 5 minutos', async () => {
    const result = await service().merge(TENANT_A.id, TENANT_A.slug, [
      alert({
        fingerprint: 'fp-a',
        nodeHint: 'api-pagos',
        startsAt: '2026-09-04T12:00:00.000Z',
      }),
      alert({
        fingerprint: 'fp-b',
        nodeHint: 'postgres',
        startsAt: '2026-09-04T12:06:00.000Z',
      }),
    ]);
    expect(result.created).toBe(2);
  });

  it('no une nodos sin camino dentro de hops', async () => {
    graph.links.mockResolvedValue([{ fromKey: 'x', toKey: 'y' }]);
    const result = await service().merge(TENANT_A.id, TENANT_A.slug, [
      alert({ fingerprint: 'fp-a', nodeHint: 'api-pagos' }),
      alert({ fingerprint: 'fp-b', nodeHint: 'otro' }),
    ]);
    expect(result.created).toBe(2);
  });

  it('sigue agrupando si faltan timestamps (compat V1)', async () => {
    const result = await service().merge(TENANT_A.id, TENANT_A.slug, [
      alert({ fingerprint: 'fp-a', nodeHint: 'api-pagos', startsAt: null }),
      alert({ fingerprint: 'fp-b', nodeHint: 'postgres', startsAt: undefined }),
    ]);
    expect(result.created).toBe(1);
  });

  it('actualiza un incidente open/acknowledged con el mismo clusterKey', async () => {
    prisma.incident.findFirst.mockResolvedValue({
      id: 'inc-existing',
      status: 'acknowledged',
    });
    const result = await service().merge(TENANT_A.id, TENANT_A.slug, [
      alert({ fingerprint: 'fp-a', nodeHint: 'api-pagos' }),
    ]);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(prisma.incident.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'inc-existing' } }),
    );
  });

  it('no reabre un incidente resolved/closed: crea uno nuevo', async () => {
    prisma.incident.findFirst.mockResolvedValue(null);
    const result = await service().merge(TENANT_A.id, TENANT_A.slug, [
      alert({ fingerprint: 'fp-a', nodeHint: 'api-pagos' }),
    ]);
    expect(result.created).toBe(1);
    expect(prisma.incident.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_A.id,
        clusterKey: clusterKeyOf(['fp-a']),
        status: { in: ['open', 'acknowledged'] },
      },
    });
  });

  it('adjunta score y evidence[] explicando el porqué', async () => {
    await service().merge(TENANT_A.id, TENANT_A.slug, [
      alert({
        fingerprint: 'fp-a',
        nodeHint: 'app-01',
        labels: { application: 'pagos' },
      }),
      alert({
        fingerprint: 'fp-b',
        nodeHint: 'api-pagos',
        startsAt: '2026-09-04T12:00:43.000Z',
        labels: { application: 'pagos' },
      }),
    ]);
    const members = prisma.incident.create.mock.calls[0][0].data.members;
    expect(members.correlation.score).toBeGreaterThan(0);
    expect(members.correlation.components.temporalScore).toBeDefined();
    expect(members.correlation.components.entityScore).toBeDefined();
    expect(members.correlation.components.topologyScore).toBeDefined();
    expect(members.correlation.components.labelScore).toBeDefined();
    expect(members.correlation.components.historicalScore).toBeDefined();
    expect(members.correlation.evidence).toEqual(
      expect.arrayContaining([
        expect.stringContaining('43 segundos'),
        expect.stringContaining('no demuestra que una alerta cause la otra'),
        expect.stringContaining('application=pagos'),
        expect.stringContaining('distancia 1'),
      ]),
    );
  });

  it('deduplica por fingerprint de alerta y consulta AgentEvent del mismo tenant', async () => {
    prisma.agentEvent.findMany.mockResolvedValue([
      {
        fingerprint: 'fp-a',
        signal: 'if_oper_down',
        assetKey: 'api-pagos',
        siteId: 'santiago',
      },
    ]);
    const result = await service().merge(TENANT_A.id, TENANT_A.slug, [
      alert({ fingerprint: 'fp-a', nodeHint: 'api-pagos', name: 'primera' }),
      alert({ fingerprint: 'fp-a', nodeHint: 'api-pagos', name: 'duplicada' }),
    ]);
    expect(result.created).toBe(1);
    const data = prisma.incident.create.mock.calls[0][0].data;
    expect(data.alertCount).toBe(1);
    expect(data.clusterKey).toBe(clusterKeyOf(['fp-a']));
    expect(data.members.collectorEvents).toEqual([
      {
        fingerprint: 'fp-a',
        signal: 'if_oper_down',
        assetKey: 'api-pagos',
      },
    ]);
    expect(prisma.agentEvent.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_A.id, fingerprint: { in: ['fp-a'] } },
      select: {
        fingerprint: true,
        signal: true,
        assetKey: true,
        siteId: true,
      },
    });
    expect(data.members.correlation.evidence[0]).toContain(
      'evento(s) persistido(s) del recolector',
    );
  });

  it('consulta historial solo del tenant actual', async () => {
    await service().merge(TENANT_A.id, TENANT_A.slug, [
      alert({ fingerprint: 'fp-a', nodeHint: 'api-pagos' }),
      alert({ fingerprint: 'fp-b', nodeHint: 'postgres' }),
    ]);
    for (const call of prisma.incident.count.mock.calls) {
      expect(call[0].where.tenantId).toBe(TENANT_A.id);
    }
    expect(graph.links).toHaveBeenCalledWith(TENANT_A.id, 'santiago');
  });

  it('impide leer un incidente de otro tenant', async () => {
    prisma.incident.findFirst.mockResolvedValue(null);
    await expect(
      service().get(TENANT_B.slug, 'inc-de-a'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.incident.findFirst).toHaveBeenCalledWith({
      where: { id: 'inc-de-a', tenantId: TENANT_B.id },
    });
  });

  it('lista solo incidentes del tenant solicitado', async () => {
    await service().list(TENANT_A.slug);
    expect(prisma.incident.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_A.id },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  });

  it('no mezcla grafo ni eventos de otro tenant al correlacionar', async () => {
    await service().merge(TENANT_B.id, TENANT_B.slug, [
      alert({ fingerprint: 'fp-shared', nodeHint: 'api-pagos' }),
    ]);
    expect(graph.links).toHaveBeenCalledWith(TENANT_B.id, 'santiago');
    expect(graph.matchNode).toHaveBeenCalledWith(
      TENANT_B.id,
      'santiago',
      'api-pagos',
    );
    expect(prisma.agentEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_B.id, fingerprint: { in: ['fp-shared'] } },
      }),
    );
    expect(prisma.incident.create.mock.calls[0][0].data.tenantId).toBe(
      TENANT_B.id,
    );
  });

  it('registra métricas de duración y clusters', async () => {
    await service().merge(TENANT_A.id, TENANT_A.slug, [
      alert({ fingerprint: 'fp-a', nodeHint: 'api-pagos' }),
    ]);
    const output = service().renderMetrics();
    expect(output).toContain('aiops_correlation_duration_seconds_count');
    expect(output).toContain('aiops_correlations_total{outcome="created"}');
  });

  it('mantiene el enum de estado: solo busca open/acknowledged', async () => {
    await service().merge(TENANT_A.id, TENANT_A.slug, [
      alert({ fingerprint: 'fp-a' }),
    ]);
    const where = prisma.incident.findFirst.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['open', 'acknowledged'] });
    expect(JSON.stringify(where)).not.toContain('DETECTED');
  });

  it('elige la peor severidad del cluster (compat V1)', async () => {
    await service().merge(TENANT_A.id, TENANT_A.slug, [
      alert({ fingerprint: 'fp-a', nodeHint: 'api-pagos', severity: 'info' }),
      alert({
        fingerprint: 'fp-b',
        nodeHint: 'postgres',
        severity: 'critical',
      }),
    ]);
    expect(prisma.incident.create.mock.calls[0][0].data.severity).toBe(
      'critical',
    );
  });

  it('mapea alertas de Alertmanager y no mezcla tenants', async () => {
    alertmanager.overview.mockResolvedValue({
      alerts: [
        {
          fingerprint: 'am-1',
          name: 'InstanceDown',
          severity: 'warning',
          state: 'active',
          endsAt: null,
          startsAt: '2026-09-04T12:00:00.000Z',
          labels: {
            site_id: 'santiago',
            asset_id: 'api-pagos',
            application: 'pagos',
          },
        },
      ],
    });
    const result = await service().correlate(TENANT_A.slug, false);
    expect(alertmanager.overview).toHaveBeenCalledWith(TENANT_A.slug, false);
    expect(result.created).toBe(1);
    expect(prisma.incident.create.mock.calls[0][0].data.tenantId).toBe(
      TENANT_A.id,
    );
  });

  it('publica series aiops_correlation_* en MetricsService', async () => {
    const platform = { registerContributor: jest.fn() };
    const svc = new CorrelationService(
      prisma as never,
      graph as never,
      alertmanager as never,
      config,
      metrics,
      platform as never,
    );
    expect(platform.registerContributor).toHaveBeenCalledWith(
      'aiops-correlation',
      expect.any(Function),
    );
    await svc.merge(TENANT_A.id, TENANT_A.slug, [
      alert({ fingerprint: 'fp-a', nodeHint: 'api-pagos' }),
    ]);
    const render = platform.registerContributor.mock
      .calls[0][1] as () => string;
    expect(render()).toContain('aiops_correlation_duration_seconds');
    expect(render()).toContain('aiops_correlations_total{outcome="created"}');
  });
});
