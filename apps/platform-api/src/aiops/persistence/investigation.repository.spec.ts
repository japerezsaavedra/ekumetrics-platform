jest.mock('../../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { InvestigationRepository } from './investigation.repository';
import { TenantScopeError } from './tenant-scope.error';

describe('InvestigationRepository aislamiento tenant', () => {
  const now = new Date('2026-09-04T12:00:00.000Z');
  const row = {
    id: 'inv-1',
    tenantId: 'tenant-a',
    incidentId: 'inc-1',
    status: 'QUEUED' as const,
    incidentLifecycle: 'DETECTED' as const,
    trigger: 'auto',
    selectedAgents: ['Rca'],
    budget: {
      maxAgents: 4,
      maxToolCalls: 20,
      maxLLMCalls: 0,
      maxTokens: 0,
      maxDurationMs: 120_000,
    },
    budgetUsed: null,
    synthesisSummary: null,
    synthesisEvidence: null,
    primaryFindingId: null,
    startedAt: null,
    completedAt: null,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  };

  const prisma = {
    aiopsInvestigation: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };

  const repository = () => new InvestigationRepository(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.aiopsInvestigation.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...row, ...data }),
    );
    prisma.aiopsInvestigation.findFirst.mockResolvedValue(null);
    prisma.aiopsInvestigation.findMany.mockResolvedValue([]);
    prisma.aiopsInvestigation.update.mockResolvedValue(row);
  });

  it('persiste siempre el tenantId del alcance', async () => {
    await repository().create('tenant-a', {
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
    });
    expect(prisma.aiopsInvestigation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-a',
        incidentId: 'inc-1',
      }),
    });
  });

  it('rechaza crear una investigación con tenantId distinto al alcance', async () => {
    await expect(
      repository().create('tenant-a', {
        tenantId: 'tenant-b',
        incidentId: 'inc-1',
      }),
    ).rejects.toBeInstanceOf(TenantScopeError);
    expect(prisma.aiopsInvestigation.create).not.toHaveBeenCalled();
  });

  it('busca y lista solo con tenantId', async () => {
    prisma.aiopsInvestigation.findFirst.mockResolvedValue(row);
    prisma.aiopsInvestigation.findMany.mockResolvedValue([row]);

    await repository().findById('tenant-a', 'inv-1');
    await repository().listByIncident('tenant-a', 'inc-1');

    expect(prisma.aiopsInvestigation.findFirst).toHaveBeenCalledWith({
      where: { id: 'inv-1', tenantId: 'tenant-a' },
    });
    expect(prisma.aiopsInvestigation.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', incidentId: 'inc-1' },
      orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    });
  });

  it('no actualiza una investigación de otro tenant', async () => {
    prisma.aiopsInvestigation.findFirst.mockResolvedValue(null);
    await expect(
      repository().update('tenant-b', 'inv-1', { status: 'RUNNING' }),
    ).rejects.toBeInstanceOf(TenantScopeError);
    expect(prisma.aiopsInvestigation.update).not.toHaveBeenCalled();
  });
});
