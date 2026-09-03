import { UnauthorizedException } from '@nestjs/common';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

jest.mock('jose', () => ({
  SignJWT: class {
    constructor(private readonly payload: Record<string, unknown>) {}
    setProtectedHeader() {
      return this;
    }
    setIssuer(value: string) {
      this.payload['iss'] = value;
      return this;
    }
    setAudience(value: string) {
      this.payload['aud'] = value;
      return this;
    }
    setSubject(value: string) {
      this.payload['sub'] = value;
      return this;
    }
    setIssuedAt() {
      return this;
    }
    setExpirationTime() {
      return this;
    }
    sign() {
      return Promise.resolve(
        `test.${Buffer.from(JSON.stringify(this.payload)).toString('base64url')}`,
      );
    }
  },
  jwtVerify: jest.fn((token: string) =>
    Promise.resolve({
      payload: JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
      ),
    }),
  ),
}));
jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { KioskService } from './kiosk.service';
import { jwtVerify } from 'jose';

describe('KioskService', () => {
  const tenant = { id: 'tenant-id', slug: 'acme' };
  const site = { id: 'site-id', slug: 'north', tenantId: tenant.id, tenant };
  let stored: Record<string, unknown>;
  let revokedAt: Date | null;
  let prisma: {
    site: { findFirst: jest.Mock };
    kioskDevice: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
    };
    auditLog: { create: jest.Mock };
    customDashboard: { findFirst: jest.Mock };
  };
  let service: KioskService;

  beforeEach(() => {
    stored = {};
    revokedAt = null;
    prisma = {
      site: { findFirst: jest.fn().mockResolvedValue(site) },
      kioskDevice: {
        create: jest.fn().mockImplementation(({ data }) => {
          stored = data;
          return Promise.resolve({
            id: 'device-id',
            ...data,
            revokedAt: null,
            lastSeenAt: null,
            lastRenewedAt: null,
            createdAt: new Date('2026-08-26T10:00:00Z'),
          });
        }),
        findUnique: jest.fn().mockImplementation(() =>
          Promise.resolve({
            id: 'device-id',
            name: 'NOC North',
            dashboard: (stored['dashboard'] as string) ?? 'custom:board-id',
            secretHash: stored['secretHash'],
            credentialExpiresAt: stored['credentialExpiresAt'],
            credentialVersion: 1,
            revokedAt,
            lastSeenAt: null,
            lastRenewedAt: null,
            createdAt: new Date('2026-08-26T10:00:00Z'),
            tenantId: tenant.id,
            tenant,
            site,
          }),
        ),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn(),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      customDashboard: { findFirst: jest.fn().mockResolvedValue({ id: 'board-id' }) },
    };
    const config = {
      get: jest
        .fn()
        .mockReturnValue('test-kiosk-signing-secret-with-32-characters'),
    };
    service = new KioskService(prisma as never, config as never);
  });

  it('emite una credencial una sola vez y almacena únicamente su hash', async () => {
    const created = await service.createDevice(
      {
        email: 'admin@acme.test',
        name: 'Admin',
        tenant: 'acme',
        role: 'admin',
      },
      { name: 'NOC North', site: 'north', dashboard: 'custom:board-id' },
    );
    expect(created.secret).toHaveLength(43);
    expect(stored['secretHash']).not.toBe(created.secret);
    expect(String(stored['secretHash'])).toHaveLength(64);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'kiosk.device.enrolled' }),
      }),
    );
  });

  it('renueva un token corto y conserva el alcance del dispositivo', async () => {
    const created = await service.createDevice(
      {
        email: 'admin@acme.test',
        name: 'Admin',
        tenant: 'acme',
        role: 'admin',
      },
      { name: 'NOC North', site: 'north', dashboard: 'custom:board-id' },
    );
    const session = await service.renew(created.id, created.secret);
    const user = await service.verifyAccessToken(session.accessToken);
    expect(session.expiresIn).toBe(600);
    expect(user).toMatchObject({
      role: 'kiosk',
      tenant: 'acme',
      site: 'north',
      dashboard: 'custom:board-id',
      deviceId: 'device-id',
    });
    expect(jest.mocked(jwtVerify)).toHaveBeenCalledWith(
      session.accessToken,
      expect.any(Uint8Array),
      {
        issuer: 'ekumetrics:kiosk',
        audience: 'portal-web',
        algorithms: ['HS256'],
      },
    );
  });

  it('rechaza una credencial incorrecta y un dispositivo revocado', async () => {
    const created = await service.createDevice(
      {
        email: 'admin@acme.test',
        name: 'Admin',
        tenant: 'acme',
        role: 'admin',
      },
      { name: 'NOC North', site: 'north', dashboard: 'custom:board-id' },
    );
    await expect(service.renew(created.id, 'incorrect')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const session = await service.renew(created.id, created.secret);
    revokedAt = new Date();
    await expect(
      service.verifyAccessToken(session.accessToken),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
