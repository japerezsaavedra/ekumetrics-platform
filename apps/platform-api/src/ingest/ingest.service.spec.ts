jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

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
        data.map(({ fingerprint }) => ({ fingerprint })),
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
});
