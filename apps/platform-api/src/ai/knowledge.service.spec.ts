jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KnowledgeService } from './knowledge.service';

describe('KnowledgeService', () => {
  const fetchMock = jest.fn();
  const prisma = {
    tenant: { findUnique: jest.fn() },
    $executeRawUnsafe: jest.fn(),
    $queryRawUnsafe: jest.fn(),
    $transaction: jest.fn(),
  };
  const service = new KnowledgeService(
    {
      get: (key: string) =>
        key === 'AI_EMBEDDING_URL'
          ? 'http://embedding.test'
          : key === 'AI_EMBEDDING_MODEL'
            ? 'qwen3-embedding:0.6b'
            : undefined,
    } as ConfigService,
    prisma as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock;
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-db-a',
      slug: 'tenant-a',
    });
    prisma.$executeRawUnsafe.mockResolvedValue(1);
    prisma.$transaction.mockImplementation((items: Array<Promise<unknown>>) =>
      Promise.all(items),
    );
  });

  it('reindexa de forma atómica y siempre acotada al tenant', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [Array(1_024).fill(0.01)] }),
    });

    const result = await service.upsertDocument(
      'tenant-a',
      'operator@example.com',
      {
        sourceKey: 'runbooks/postgres-capacity',
        sourceType: 'runbook',
        title: 'Capacidad de PostgreSQL',
        version: '1.2.0',
        component: 'postgresql',
        content:
          '# Diagnóstico\nRevise conexiones, disco y consultas bloqueadas.',
      },
    );

    expect(result.chunks).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRawUnsafe).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('DELETE FROM "AiKnowledgeDocument"'),
      'tenant-db-a',
      'runbooks/postgres-capacity',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://embedding.test/api/embed',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('degrada a full-text si embeddings no está disponible al consultar', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    prisma.$queryRawUnsafe.mockResolvedValue([]);

    await expect(
      service.search('tenant-a', 'viewer@example.com', 'causa de cpu alta', 8),
    ).resolves.toEqual([]);

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('plainto_tsquery'),
      'tenant-db-a',
      'causa de cpu alta',
      8,
    );
  });

  it('lista solo documentos del tenant y calcula su vigencia', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([
      {
        id: 'doc-a',
        sourceKey: 'runbooks/postgres',
        sourceType: 'runbook',
        title: 'PostgreSQL',
        version: '1.0.0',
        component: 'postgresql',
        checksum: 'a'.repeat(64),
        approvedBy: 'operator@example.com',
        approvedAt: new Date('2026-08-20T00:00:00.000Z'),
        validFrom: new Date('2026-08-20T00:00:00.000Z'),
        validUntil: null,
        updatedAt: new Date('2026-08-20T00:00:00.000Z'),
        chunkCount: 3n,
      },
    ]);

    const rows = await service.listDocuments('tenant-a', 'admin@example.com');

    expect(rows[0]).toMatchObject({
      id: 'doc-a',
      chunkCount: 3,
      status: 'active',
    });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('d."tenantId" = $1'),
      'tenant-db-a',
    );
  });

  it('rechaza telemetría cruda como tipo de conocimiento', async () => {
    await expect(
      service.upsertDocument('tenant-a', 'operator@example.com', {
        sourceKey: 'raw/logs',
        sourceType: 'telemetry' as never,
        title: 'Logs',
        version: '1',
        content: 'dato',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
