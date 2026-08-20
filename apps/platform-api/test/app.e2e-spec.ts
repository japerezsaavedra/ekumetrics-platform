jest.mock('../src/prisma/prisma.service', () => ({
  PrismaService: class PrismaService {
    $queryRaw = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    $disconnect = jest.fn();
  },
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

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', service: 'platform-api' });
  });

  afterEach(async () => {
    await app.close();
  });
});
