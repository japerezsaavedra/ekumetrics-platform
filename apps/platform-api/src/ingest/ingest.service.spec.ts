jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { createHash } from 'node:crypto';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IngestService, parseAgentCertificateDn } from './ingest.service';

const event = {
  timestamp: '2026-08-26T12:00:00Z',
  tenant_id: 'cliente',
  site_id: 'santiago',
  agent_id: 'agent-01',
  asset_id: 'site/santiago/ip/10.0.0.1',
  asset_type: 'switch',
  signal: 'asset_discovered',
  value: 1,
  severity: 'info',
  source: 'discovery',
  tags: { ip: '10.0.0.1' },
};

describe('IngestService', () => {
  const prisma = {
    tenant: { findUnique: jest.fn() },
    site: { findUnique: jest.fn() },
    agent: { findUnique: jest.fn(), update: jest.fn() },
    agentEvent: { createManyAndReturn: jest.fn() },
    asset: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'INGEST_SHARED_KEY' ? 'secret' : undefined,
    ),
  };
  const graph = { upsertNeighbor: jest.fn() };
  const service = () =>
    new IngestService(
      config as unknown as ConfigService,
      prisma as never,
      graph as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-db',
      slug: 'cliente',
    });
    prisma.site.findUnique.mockResolvedValue({
      id: 'site-db',
      slug: 'santiago',
    });
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-db',
      siteId: 'santiago',
    });
    prisma.agentEvent.createManyAndReturn.mockImplementation(
      ({ data }: { data: Array<{ fingerprint: string }> }) =>
        data.map(({ fingerprint }, index) => ({
          id: `evt-${index}`,
          fingerprint,
          tenantId: 'tenant-db',
          siteId: 'santiago',
          agentId: 'agent-db',
          assetKey: 'site/santiago/ip/10.0.0.1',
          assetType: 'switch',
          signal: 'asset_discovered',
          value: 1,
          unit: null,
          category: 'ASSET',
          entityType: 'switch',
          environment: null,
          eventAt: new Date('2026-08-26T12:00:00Z'),
          metadata: null,
          tags: { ip: '10.0.0.1' },
          source: 'discovery',
        })),
    );
    prisma.asset.findUnique.mockResolvedValue(null);
    prisma.asset.create.mockResolvedValue({});
    prisma.asset.update.mockResolvedValue({});
    prisma.agent.update.mockResolvedValue({});
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );
  });

  it('rechaza una llamada sin credencial interna', async () => {
    await expect(service().ingest([event])).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rechaza un agente no registrado', async () => {
    prisma.agent.findUnique.mockResolvedValue(null);
    await expect(service().ingest([event], 'secret')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rechaza un sitio no registrado', async () => {
    prisma.site.findUnique.mockResolvedValue(null);
    await expect(service().ingest([event], 'secret')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('persiste, actualiza lastSeen e inventario en una transacción', async () => {
    const result = await service().ingest([event], 'secret');
    expect(result).toEqual({
      status: 'accepted',
      received: 1,
      accepted: 1,
      duplicates: 0,
    });
    expect(prisma.agentEvent.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(prisma.asset.create).toHaveBeenCalled();
    expect(prisma.agent.update).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('aísla el evento al tenant registrado, no al slug del envelope', async () => {
    await service().ingest([event], 'secret');
    const payload = prisma.agentEvent.createManyAndReturn.mock.calls[0][0];
    expect(payload.data[0].tenantId).toBe('tenant-db');
    expect(payload.data[0].tenantId).not.toBe(event.tenant_id);
    expect(payload.data[0].category).toBe('ASSET');
    expect(payload.data[0].entityType).toBe('switch');
  });

  it('conserva el fingerprint de envelopes antiguos', async () => {
    await service().ingest([event], 'secret');
    const payload = prisma.agentEvent.createManyAndReturn.mock.calls[0][0];
    expect(payload.data[0].fingerprint).toBe(
      '9577aecc0e247a58ac05a1b5849b61770e677f00a60fd93bf912c2c54aeb4eb4',
    );
    expect(payload.data[0].metadata).toBeUndefined();
    expect(payload.data[0].fingerprint).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({
            timestamp: '2026-08-26T12:00:00.000Z',
            tenant_id: 'cliente',
            site_id: 'santiago',
            agent_id: 'agent-01',
            asset_id: 'site/santiago/ip/10.0.0.1',
            asset_type: 'switch',
            vendor: '',
            tier: null,
            signal: 'asset_discovered',
            value: 1,
            unit: '',
            severity: 'info',
            source: 'discovery',
            tags: { ip: '10.0.0.1' },
          }),
        )
        .digest('hex'),
    );
  });

  it('promueve tags.environment al campo indexado sin cambiar el envelope', async () => {
    await service().ingest(
      [{ ...event, tags: { ip: '10.0.0.1', environment: 'production' } }],
      'secret',
    );
    const row = prisma.agentEvent.createManyAndReturn.mock.calls[0][0].data[0];
    expect(row.environment).toBe('production');
    expect(row.tenantId).toBe('tenant-db');
  });

  it('persiste metadata AIOps sin cruzar tenants', async () => {
    await service().ingest(
      [
        {
          ...event,
          signal: 'metric.anomaly',
          category: 'METRIC_SIGNAL',
          entity_type: 'host',
          correlation_key: 'cpu-host-1',
          environment: 'production',
          trace_id: 'aabbccddeeff00112233445566778899',
          metadata: {
            anomalyScore: 2.4,
            metricName: 'node_cpu_seconds',
            entityId: 'host-1',
          },
        },
      ],
      'secret',
    );
    const row = prisma.agentEvent.createManyAndReturn.mock.calls[0][0].data[0];
    expect(row.tenantId).toBe('tenant-db');
    expect(row.category).toBe('METRIC_SIGNAL');
    expect(row.entityType).toBe('host');
    expect(row.correlationKey).toBe('cpu-host-1');
    expect(row.environment).toBe('production');
    expect(row.traceId).toBe('aabbccddeeff00112233445566778899');
    expect(row.metadata).toEqual({
      anomalyScore: 2.4,
      metricName: 'node_cpu_seconds',
      entityId: 'host-1',
    });
  });

  it('informa eventos duplicados sin tratarlos como error', async () => {
    prisma.agentEvent.createManyAndReturn.mockResolvedValue([]);
    await expect(service().ingest([event], 'secret')).resolves.toEqual(
      expect.objectContaining({ accepted: 0, duplicates: 1 }),
    );
    expect(prisma.asset.create).not.toHaveBeenCalled();
  });

  it('no deja que una observación antigua sobrescriba inventario nuevo', async () => {
    prisma.asset.findUnique.mockResolvedValue({
      id: 'asset-db',
      lastObservedAt: new Date('2026-08-27T12:00:00Z'),
    });
    await service().ingest([{ ...event, signal: 'asset_stale' }], 'secret');
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it('interpreta la identidad canónica de un certificado de agente', () => {
    expect(
      parseAgentCertificateDn('CN=agent-01,OU=santiago,O=cliente'),
    ).toEqual({
      tenantId: 'cliente',
      siteId: 'santiago',
      agentId: 'agent-01',
    });
    expect(parseAgentCertificateDn('CN=agent-01,OU=santiago')).toBeNull();
    expect(
      parseAgentCertificateDn('CN=agent-01,CN=otro,OU=santiago,O=cliente'),
    ).toBeNull();
  });

  it('en producción exige un borde autenticado y un certificado coincidente', async () => {
    config.get.mockImplementation(
      (key: string) =>
        ({
          INGEST_SHARED_KEY: 'secret',
          DEPLOYMENT_MODE: 'production',
          AGENT_EDGE_ASSERTION_KEY: 'edge-secret',
        })[key],
    );

    await expect(service().ingest([event], 'secret')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      service().ingest(
        [event],
        'secret',
        'CN=otro,OU=santiago,O=cliente',
        'edge-secret',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service().ingest(
        [event],
        'secret',
        'CN=agent-01,OU=santiago,O=cliente',
        'edge-secret',
      ),
    ).resolves.toEqual(expect.objectContaining({ accepted: 1 }));
  });

  it('encola ekumetrics.events.ingested en el outbox sin duplicar AgentEvent', async () => {
    config.get.mockImplementation((key: string) =>
      key === 'INGEST_SHARED_KEY' ? 'secret' : undefined,
    );
    const outbox = {
      enqueueMany: jest.fn().mockResolvedValue(undefined),
      flush: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new IngestService(
      config as unknown as ConfigService,
      prisma as never,
      graph as never,
      outbox as never,
    );
    await svc.ingest(
      [
        {
          ...event,
          signal: 'metric.anomaly',
          asset_id: 'postgres.prod',
          metadata: { metricName: 'db_latency_ms', entityId: 'postgres.prod' },
        },
      ],
      'secret',
    );
    expect(outbox.enqueueMany).toHaveBeenCalled();
    const rows = outbox.enqueueMany.mock.calls[0][1] as Array<{
      subject: string;
      payload: { tenantId: string; agentEventId: string; signal: string };
      headers: { tenantId: string };
      idempotencyKey: string;
    }>;
    expect(rows[0].subject).toBe('ekumetrics.events.ingested');
    expect(rows[0].payload.tenantId).toBe('tenant-db');
    expect(rows[0].headers.tenantId).toBe(rows[0].payload.tenantId);
    expect(rows[0].payload.agentEventId).toBe('evt-0');
    expect(rows[0].idempotencyKey).toContain('events.ingested');
    expect(outbox.flush).toHaveBeenCalled();
  });
});
