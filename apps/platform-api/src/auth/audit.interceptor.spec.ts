import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';

jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { AuditInterceptor } from './audit.interceptor';

describe('AuditInterceptor', () => {
  it('registra solicitud y éxito sin copiar secretos del body', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue({
        action: 'tenant.user.created',
        entity: 'user',
      }),
    };
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ id: 'tenant-id' }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-id' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const request = {
      method: 'POST',
      route: { path: '/v1/admin/users' },
      params: {},
      query: {},
      headers: {},
      body: {
        tenantSlug: 'acme',
        email: 'new@acme.test',
        password: 'must-not-be-audited',
      },
      user: {
        email: 'admin@acme.test',
        name: 'Admin',
        tenant: 'acme',
        role: 'admin',
      },
    };
    const context = {
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    const next = { handle: () => of({ id: 'new-user-id' }) } as CallHandler;

    const interceptor = new AuditInterceptor(
      reflector as never,
      prisma as never,
    );
    await expect(
      firstValueFrom(interceptor.intercept(context, next)),
    ).resolves.toEqual({
      id: 'new-user-id',
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-id',
        actor: 'admin@acme.test',
        action: 'tenant.user.created.requested',
        entity: 'user',
        entityId: null,
        metadata: {
          method: 'POST',
          route: '/v1/admin/users',
          targetTenant: 'acme',
        },
      },
      select: { id: true },
    });
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain(
      'must-not-be-audited',
    );
    expect(prisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: 'audit-id' },
      data: {
        action: 'tenant.user.created.succeeded',
        entityId: 'new-user-id',
      },
    });
  });
});
