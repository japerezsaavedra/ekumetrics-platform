jest.mock('../../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { ConfigService } from '@nestjs/config';
import { DEFAULT_RCA_WEIGHTS, RcaScoringPolicyLoader } from './scoring-policy';

describe('RcaScoringPolicyLoader', () => {
  it('prioriza RcaScoringPolicy tenant+environment sobre Policy genérica', async () => {
    const prisma = {
      rcaScoringPolicy: {
        findUnique: jest.fn().mockResolvedValue({
            tenantId: 'tenant-a',
            temporalWeight: 1,
            topologyWeight: 0,
            anomalyWeight: 0,
            dependencyWeight: 0,
            historicalWeight: 0,
            hops: 3,
          }),
      },
      policy: { findFirst: jest.fn() },
    };
    const loader = new RcaScoringPolicyLoader(
      prisma as never,
      { get: () => undefined } as unknown as ConfigService,
    );
    const weights = await loader.getWeights('tenant-a', 'prod');
    expect(weights.temporal).toBe(1);
    expect(prisma.policy.findFirst).not.toHaveBeenCalled();
    expect(await loader.getHops('tenant-a', 'prod')).toBe(3);
  });

  it('usa Policy rca_scoring si no hay fila estructurada', async () => {
    const prisma = {
      rcaScoringPolicy: { findUnique: jest.fn().mockResolvedValue(null) },
      policy: {
        findFirst: jest.fn().mockResolvedValue({
          payload: {
            weights: {
              temporal: 0,
              topology: 0,
              anomaly: 0,
              dependency: 1,
              historical: 0,
            },
            hops: 4,
          },
        }),
      },
    };
    const loader = new RcaScoringPolicyLoader(
      prisma as never,
      { get: () => undefined } as unknown as ConfigService,
    );
    const weights = await loader.getWeights('tenant-a');
    expect(weights.dependency).toBe(1);
    expect(await loader.getHops('tenant-a')).toBe(4);
  });

  it('cae a defaults de aplicación si no hay policy', async () => {
    const prisma = {
      rcaScoringPolicy: { findUnique: jest.fn().mockResolvedValue(null) },
      policy: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const loader = new RcaScoringPolicyLoader(
      prisma as never,
      { get: () => undefined } as unknown as ConfigService,
    );
    expect(await loader.getWeights('tenant-a')).toEqual(DEFAULT_RCA_WEIGHTS);
  });
});
