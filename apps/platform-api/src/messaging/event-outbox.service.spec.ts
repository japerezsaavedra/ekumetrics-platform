jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { EventBusUnavailableError } from './errors';
import { EventOutboxMetrics } from './event-outbox.metrics';
import { EventOutboxService } from './event-outbox.service';
import { EventSubjects, buildHeaders } from './index';
import { InMemoryEventBus } from './in-memory.event-bus';
import { InMemoryIdempotencyStore } from './idempotency';
import { OUTBOX_STATUS } from './event-outbox.types';

describe('EventOutboxService', () => {
  it('encola con skipDuplicates y publica filas reclamadas', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const prisma = {
      aiopsEventOutbox: {
        createMany: jest.fn(
          async ({
            data,
          }: {
            data: Array<Record<string, unknown>>;
            skipDuplicates?: boolean;
          }) => {
            for (const item of data) {
              const exists = rows.some(
                (row) =>
                  row.tenantId === item.tenantId &&
                  row.idempotencyKey === item.idempotencyKey,
              );
              if (!exists) {
                rows.push({
                  ...item,
                  id: `ob-${rows.length + 1}`,
                  attempts: 0,
                  status: OUTBOX_STATUS.PENDING,
                });
              }
            }
            return { count: data.length };
          },
        ),
        findMany: jest.fn(async () =>
          rows.filter((row) => row.status === OUTBOX_STATUS.PENDING),
        ),
        updateMany: jest.fn(
          async ({
            where,
            data,
          }: {
            where: { id?: string; status?: string };
            data: Record<string, unknown>;
          }) => {
            const target = rows.find((row) => {
              if (where.id && row.id !== where.id) return false;
              if (where.status && row.status !== where.status) return false;
              return true;
            });
            if (!target) return { count: 0 };
            Object.assign(target, data);
            if (
              data.attempts &&
              typeof data.attempts === 'object' &&
              'increment' in (data.attempts as object)
            ) {
              target.attempts =
                Number(target.attempts) +
                Number((data.attempts as { increment: number }).increment);
            }
            return { count: 1 };
          },
        ),
      },
    };
    const bus = new InMemoryEventBus(new InMemoryIdempotencyStore());
    const metrics = new EventOutboxMetrics();
    const outbox = new EventOutboxService(
      prisma as never,
      bus,
      metrics,
    );
    const headers = buildHeaders({
      tenantId: 'tenant-a',
      correlationId: 'c1',
      producedBy: 'test',
    });
    await outbox.enqueueMany(prisma as never, [
      {
        tenantId: 'tenant-a',
        subject: EventSubjects.EVENTS_INGESTED,
        idempotencyKey: 'tenant-a:events.ingested:e1',
        payload: { tenantId: 'tenant-a', agentEventId: 'e1', signal: 'metric' },
        headers,
      },
      {
        tenantId: 'tenant-a',
        subject: EventSubjects.EVENTS_INGESTED,
        idempotencyKey: 'tenant-a:events.ingested:e1',
        payload: { tenantId: 'tenant-a', agentEventId: 'e1', signal: 'metric' },
        headers,
      },
    ]);
    expect(prisma.aiopsEventOutbox.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    await outbox.flush();
    expect(metrics.render()).toContain(
      'aiops_events_ingested_published_total 1',
    );
    await bus.close();
  });

  it('no publica si otra réplica ya reclamó la fila', async () => {
    const prisma = {
      aiopsEventOutbox: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'ob-1',
            tenantId: 'tenant-a',
            subject: EventSubjects.EVENTS_INGESTED,
            idempotencyKey: 'k1',
            payload: { tenantId: 'tenant-a' },
            headers: buildHeaders({
              tenantId: 'tenant-a',
              correlationId: 'c',
              producedBy: 'test',
            }),
            attempts: 0,
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const bus = { publish: jest.fn() };
    const outbox = new EventOutboxService(
      prisma as never,
      bus as never,
      new EventOutboxMetrics(),
    );
    await outbox.flush();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('registra fallo y reencola si el bus no está disponible', async () => {
    const row = {
      id: 'ob-1',
      tenantId: 'tenant-a',
      subject: EventSubjects.RCA_REQUESTED,
      idempotencyKey: 'k1',
      payload: { tenantId: 'tenant-a', incidentId: 'inc-1' },
      headers: buildHeaders({
        tenantId: 'tenant-a',
        correlationId: 'c',
        producedBy: 'test',
      }),
      attempts: 0,
      status: OUTBOX_STATUS.PENDING,
    };
    const prisma = {
      aiopsEventOutbox: {
        findMany: jest.fn().mockResolvedValue([row]),
        updateMany: jest.fn().mockImplementation(async ({ data }) => {
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
    };
    const bus = {
      publish: jest.fn().mockRejectedValue(new EventBusUnavailableError()),
    };
    const metrics = new EventOutboxMetrics();
    const outbox = new EventOutboxService(
      prisma as never,
      bus as never,
      metrics,
    );
    await outbox.flush();
    expect(metrics.render()).toContain(
      'aiops_rca_requested_publish_failures_total 1',
    );
    expect(row.status).toBe(OUTBOX_STATUS.PENDING);
  });

  it('rechaza mismatch de tenantId header/payload', async () => {
    const outbox = new EventOutboxService(
      {} as never,
      {} as never,
      new EventOutboxMetrics(),
    );
    await expect(
      outbox.enqueueMany({ aiopsEventOutbox: { createMany: jest.fn() } }, [
        {
          tenantId: 'tenant-a',
          subject: EventSubjects.EVENTS_INGESTED,
          idempotencyKey: 'k',
          payload: { tenantId: 'tenant-a' },
          headers: buildHeaders({
            tenantId: 'tenant-b',
            correlationId: 'c',
            producedBy: 'test',
          }),
        },
      ]),
    ).rejects.toThrow(/mismatch/);
  });
});
