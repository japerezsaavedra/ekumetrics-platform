jest.mock('../../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HistoricalController } from './historical.controller';
import { HistoricalService } from './historical.service';
import { InMemoryHistoricalRepository } from './in-memory.historical.repository';
import { NEUTRAL_HISTORICAL_SCORE } from './types';

const user = {
  email: 'ops@gradotech.dev',
  name: 'Ops',
  tenant: 'acme',
  role: 'admin' as const,
};

describe('HistoricalController', () => {
  const prisma = {
    tenant: { findUnique: jest.fn() },
    incident: { findFirst: jest.fn() },
  };
  let controller: HistoricalController;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-a',
      slug: 'acme',
    });
    prisma.incident.findFirst.mockResolvedValue({
      id: 'inc-1',
      tenantId: 'tenant-a',
    });
    controller = new HistoricalController(
      new HistoricalService(new InMemoryHistoricalRepository()),
      prisma as never,
    );
  });

  it('persiste feedback CONFIRM y lo lista en el tenant', async () => {
    const created = await controller.recordFeedback(
      user,
      'inc-1',
      {
        action: 'CONFIRM',
        confirmedRootCause: 'postgres.prod',
        note: 'Causa confirmada por el operador.',
        signature: {
          tenantId: 'ignored-should-be-overwritten',
          entityTypes: ['database'],
          service: 'checkout',
          eventTypes: ['metric.anomaly'],
          topologyPattern: 'database>service',
          environment: 'production',
        },
      },
    );
    expect(created.action).toBe('CONFIRM');
    expect(created.tenantId).toBe('tenant-a');
    expect(created.userId).toBe(user.email);

    const listed = await controller.listFeedback(user, 'inc-1');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
  });

  it('no expone incidentes de otro tenant (404)', async () => {
    prisma.incident.findFirst.mockResolvedValue(null);
    await expect(
      controller.listFeedback(user, 'inc-foreign'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.incident.findFirst).toHaveBeenCalledWith({
      where: { id: 'inc-foreign', tenantId: 'tenant-a' },
    });
  });

  it('lookup sin historial previo es NEUTRAL', async () => {
    const contribution = await controller.lookup(
      user,
      'inc-1',
      {
        entityTypes: ['service'],
        service: 'checkout',
        eventTypes: ['alert.received'],
        environment: 'production',
      },
    );
    expect(contribution.matches).toEqual([]);
    expect(contribution.historicalScore).toBe(NEUTRAL_HISTORICAL_SCORE);
    expect(contribution.overridesCurrentEvidence).toBe(false);
  });

  it('rechaza action inválida', async () => {
    await expect(
      controller.recordFeedback(user, 'inc-1', { action: 'DELETE' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
