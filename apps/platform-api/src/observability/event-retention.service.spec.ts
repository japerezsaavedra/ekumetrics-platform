import { ConfigService } from '@nestjs/config';

jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { EventRetentionService } from './event-retention.service';

describe('EventRetentionService', () => {
  it('elimina eventos vencidos por lotes y registra éxito', async () => {
    const config = {
      get: jest.fn(
        (key: string) =>
          ({
            EVENT_RETENTION_BATCH_SIZE: '100',
            EVENT_RETENTION_MAX_BATCHES: '3',
          })[key],
      ),
    } as unknown as ConfigService;
    const prisma = {
      agentEvent: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(
            Array.from({ length: 100 }, (_, index) => ({
              id: `event-${index}`,
            })),
          )
          .mockResolvedValueOnce([{ id: 'last' }]),
        deleteMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 100 })
          .mockResolvedValueOnce({ count: 1 }),
      },
    };
    const metrics = {
      recordRetentionSuccess: jest.fn(),
      recordRetentionFailure: jest.fn(),
    };
    const service = new EventRetentionService(
      config,
      prisma as never,
      metrics as never,
    );

    await expect(service.purge(30)).resolves.toBe(101);
    expect(prisma.agentEvent.deleteMany).toHaveBeenCalledTimes(2);
    expect(metrics.recordRetentionSuccess).toHaveBeenCalledWith(101);
  });

  it('reporta fallos sin dejar una promesa rechazada en background', async () => {
    const config = { get: jest.fn() } as unknown as ConfigService;
    const prisma = {
      agentEvent: {
        findMany: jest.fn().mockRejectedValue(new Error('database full')),
      },
    };
    const metrics = {
      recordRetentionSuccess: jest.fn(),
      recordRetentionFailure: jest.fn(),
    };
    const service = new EventRetentionService(
      config,
      prisma as never,
      metrics as never,
    );

    await expect(service.purge(30)).resolves.toBe(0);
    expect(metrics.recordRetentionFailure).toHaveBeenCalledTimes(1);
  });
});
