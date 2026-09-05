jest.mock('../../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { AgentFindingRepository } from './agent-finding.repository';
import { TenantScopeError } from './tenant-scope.error';

describe('AgentFindingRepository aislamiento tenant', () => {
  const now = new Date('2026-09-04T12:00:00.000Z');
  const row = {
    id: 'find-1',
    tenantId: 'tenant-a',
    incidentId: 'inc-1',
    investigationId: null,
    agentType: 'Rca',
    status: 'PENDING' as const,
    summary: '',
    evidence: [],
    confidence: null,
    startedAt: null,
    completedAt: null,
    provider: null,
    model: null,
    toolCalls: null,
    errors: null,
    createdAt: now,
    updatedAt: now,
  };

  const prisma = {
    agentFinding: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    aiopsInvestigation: {
      findFirst: jest.fn(),
    },
  };

  const repository = () => new AgentFindingRepository(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.agentFinding.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...row, ...data }),
    );
    prisma.agentFinding.findFirst.mockResolvedValue(null);
    prisma.agentFinding.findMany.mockResolvedValue([]);
    prisma.agentFinding.update.mockResolvedValue(row);
    prisma.aiopsInvestigation.findFirst.mockResolvedValue(null);
  });

  it('persiste siempre el tenantId del alcance, no el del payload', async () => {
    await repository().create('tenant-a', {
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
      agentType: 'Rca',
    });
    expect(prisma.agentFinding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-a',
        incidentId: 'inc-1',
        agentType: 'Rca',
      }),
    });
  });

  it('rechaza crear un finding con tenantId distinto al alcance', async () => {
    await expect(
      repository().create('tenant-a', {
        tenantId: 'tenant-b',
        incidentId: 'inc-1',
        agentType: 'Rca',
      }),
    ).rejects.toBeInstanceOf(TenantScopeError);
    expect(prisma.agentFinding.create).not.toHaveBeenCalled();
  });

  it('busca y lista solo con tenantId + id/incidente', async () => {
    prisma.agentFinding.findFirst.mockResolvedValue(row);
    prisma.agentFinding.findMany.mockResolvedValue([row]);

    await repository().findById('tenant-a', 'find-1');
    await repository().listByIncident('tenant-a', 'inc-1');

    expect(prisma.agentFinding.findFirst).toHaveBeenCalledWith({
      where: { id: 'find-1', tenantId: 'tenant-a' },
    });
    expect(prisma.agentFinding.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', incidentId: 'inc-1' },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('no actualiza un finding de otro tenant', async () => {
    prisma.agentFinding.findFirst.mockResolvedValue(null);
    await expect(
      repository().update('tenant-b', 'find-1', { status: 'RUNNING' }),
    ).rejects.toBeInstanceOf(TenantScopeError);
    expect(prisma.agentFinding.update).not.toHaveBeenCalled();
  });

  it('no enlaza un finding a una investigación de otro tenant', async () => {
    prisma.aiopsInvestigation.findFirst.mockResolvedValue(null);
    await expect(
      repository().create('tenant-a', {
        tenantId: 'tenant-a',
        incidentId: 'inc-1',
        investigationId: 'inv-other',
        agentType: 'Rca',
      }),
    ).rejects.toBeInstanceOf(TenantScopeError);
    expect(prisma.aiopsInvestigation.findFirst).toHaveBeenCalledWith({
      where: { id: 'inv-other', tenantId: 'tenant-a' },
    });
    expect(prisma.agentFinding.create).not.toHaveBeenCalled();
  });

  it('no completa un finding sin evidencia', async () => {
    prisma.agentFinding.findFirst.mockResolvedValue({
      ...row,
      status: 'RUNNING',
    });
    await expect(
      repository().update('tenant-a', 'find-1', {
        status: 'COMPLETED',
        summary: 'causa',
        evidence: [],
      }),
    ).rejects.toThrow(/evidencia/);
    expect(prisma.agentFinding.update).not.toHaveBeenCalled();
  });
});
