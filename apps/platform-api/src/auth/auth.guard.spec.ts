import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';

jest.mock('./auth.service', () => ({ AuthService: class AuthService {} }));

import { ALLOW_KIOSK } from './allow-kiosk';
import { AuthGuard } from './auth.guard';
import { IS_PUBLIC } from './public';
import { AUTH_ROLES } from './roles';

function context(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function reflector(metadata: Record<string, unknown>) {
  return {
    getAllAndOverride: jest.fn((key: string) => metadata[key]),
  };
}

describe('AuthGuard RBAC deny-by-default', () => {
  it('permite endpoints públicos sin verificar un token', async () => {
    const auth = { authenticate: jest.fn() };
    const guard = new AuthGuard(
      auth as never,
      reflector({ [IS_PUBLIC]: true }) as never,
    );
    await expect(guard.canActivate(context({ headers: {} }))).resolves.toBe(
      true,
    );
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it('rechaza un endpoint autenticado sin una política de roles', async () => {
    const auth = {
      authenticate: jest
        .fn()
        .mockResolvedValue({ user: { role: 'admin' }, csrfToken: '' }),
    };
    const guard = new AuthGuard(auth as never, reflector({}) as never);
    await expect(
      guard.canActivate(
        context({ headers: { authorization: 'Bearer token' } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('impide a viewer ejecutar una operación exclusiva de administradores', async () => {
    const auth = {
      authenticate: jest
        .fn()
        .mockResolvedValue({ user: { role: 'viewer' }, csrfToken: '' }),
    };
    const guard = new AuthGuard(
      auth as never,
      reflector({ [AUTH_ROLES]: ['operator', 'admin'] }) as never,
    );
    await expect(
      guard.canActivate(
        context({ headers: { authorization: 'Bearer token' } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('permite el rol declarado y adjunta el usuario validado', async () => {
    const user = { role: 'admin', tenant: 'acme' };
    const auth = {
      authenticate: jest.fn().mockResolvedValue({ user, csrfToken: 'csrf' }),
    };
    const request = {
      headers: { authorization: 'Bearer token' },
      user: undefined,
    };
    const guard = new AuthGuard(
      auth as never,
      reflector({ [AUTH_ROLES]: ['operator', 'admin'] }) as never,
    );
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.user).toBe(user);
    expect((request as { csrfToken?: string }).csrfToken).toBe('csrf');
  });

  it('exige autorización kiosk además del rol', async () => {
    const auth = {
      authenticate: jest
        .fn()
        .mockResolvedValue({ user: { role: 'kiosk' }, csrfToken: '' }),
    };
    const denied = new AuthGuard(
      auth as never,
      reflector({ [AUTH_ROLES]: ['kiosk'] }) as never,
    );
    await expect(
      denied.canActivate(
        context({ headers: { authorization: 'Bearer token' } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const allowed = new AuthGuard(
      auth as never,
      reflector({ [AUTH_ROLES]: ['kiosk'], [ALLOW_KIOSK]: true }) as never,
    );
    await expect(
      allowed.canActivate(
        context({ headers: { authorization: 'Bearer token' } }),
      ),
    ).resolves.toBe(true);
  });
});
