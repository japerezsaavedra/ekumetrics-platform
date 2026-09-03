jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

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
    });
  });
});
