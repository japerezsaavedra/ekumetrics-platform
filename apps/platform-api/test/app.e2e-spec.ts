jest.mock('../src/prisma/prisma.service', () => ({
  PrismaService: class PrismaService {
    $queryRaw = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    $disconnect = jest.fn();
    aiopsEventOutbox = {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
  },
}));
jest.mock('../src/auth/auth.service', () => ({
  AuthService: class AuthService {},
}));
jest.mock('../src/kiosk/kiosk.service', () => ({
  KioskService: class KioskService {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/health (GET)', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    const body = response.body as unknown;
    expect(body).toMatchObject({ status: 'ok', service: 'platform-api' });
    expect((body as { version: unknown }).version).toEqual(expect.any(String));
  });

  afterEach(async () => {
    await app.close();
  });
});
