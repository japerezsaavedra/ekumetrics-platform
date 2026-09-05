jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import type { EventBus } from '../messaging/event-bus';
import { EVENT_BUS } from '../messaging/tokens';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('1.0.0') },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('returns liveness', () => {
    expect(controller.liveness()).toEqual({
      status: 'ok',
      service: 'platform-api',
      version: '1.0.0',
    });
  });

  it('returns readiness when the database answers', async () => {
    await expect(controller.readiness()).resolves.toEqual({
      status: 'ready',
      service: 'platform-api',
      version: '1.0.0',
      checks: {
        database: 'ok',
        eventBus: 'degraded',
      },
    });
  });

  it('reports eventBus ok without failing readiness when the bus pings', async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('1.0.0') },
        },
        {
          provide: EVENT_BUS,
          useValue: {
            ping: jest.fn().mockResolvedValue(true),
          } satisfies Pick<EventBus, 'ping'>,
        },
      ],
    }).compile();

    const withBus = module.get(HealthController);
    await expect(withBus.readiness()).resolves.toMatchObject({
      status: 'ready',
      checks: { database: 'ok', eventBus: 'ok' },
    });
  });
});
