import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => 'trusted-jwks'),
  decodeJwt: jest.fn(() => ({
    iss: 'https://identity.example/realms/ekumetrics',
  })),
  jwtVerify: jest.fn(),
}));
jest.mock('../kiosk/kiosk.service', () => ({
  KioskService: class KioskService {},
}));
jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AuthService } from './auth.service';

describe('AuthService token validation', () => {
  const verify = jest.mocked(jwtVerify);
  const remoteKeys = jest.mocked(createRemoteJWKSet);
  const config = {
    get: jest.fn(
      (key: string) =>
        ({
          KEYCLOAK_URL: 'https://identity.example',
          KEYCLOAK_INTERNAL_URL: 'http://keycloak:8080',
          KEYCLOAK_REALM: 'ekumetrics',
          KEYCLOAK_AUDIENCE: 'portal-web',
          KEYCLOAK_CLIENT_ID: 'portal-web',
          PORTAL_PUBLIC_URL: 'https://monitoring.example',
          API_PUBLIC_URL: 'https://api.example',
          BFF_SESSION_SECRET:
            'a-secure-test-secret-with-more-than-32-characters',
        })[key],
    ),
  };
  const identity = {
    optionsForEmail: jest.fn().mockResolvedValue({
      mfaRequired: false,
      entraEnabled: false,
      adEnabled: false,
      idpHint: '',
    }),
  };
  const keycloak = {
    hasOtp: jest.fn().mockResolvedValue(false),
    otpPolicy: jest.fn().mockResolvedValue({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    }),
    registerOtp: jest.fn(),
    clearTotpRequired: jest.fn(),
    clearLoginBlockingActions: jest.fn(),
  };
  const kiosk = { verifyAccessToken: jest.fn() };
  const prisma = {
    webSession: {
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as never;
    prisma.webSession.deleteMany.mockResolvedValue({ count: 0 });
    prisma.webSession.create.mockResolvedValue({});
    prisma.webSession.findMany.mockResolvedValue([]);
    verify.mockResolvedValue({
      payload: {
        typ: 'Bearer',
        sub: 'user-1',
        email: 'operator@example.test',
        tenant: 'default',
        realm_access: { roles: ['operator'] },
      },
      protectedHeader: { alg: 'RS256' },
      key: {} as never,
    });
  });

  it('accepts only RS256 access tokens from the configured issuer and audience', async () => {
    const service = new AuthService(
      config as never,
      kiosk as never,
      prisma as never,
      identity as never,
      keycloak as never,
    );

    await expect(service.verify('Bearer signed-token')).resolves.toMatchObject({
      email: 'operator@example.test',
      tenant: 'default',
      role: 'operator',
    });
    expect(remoteKeys).toHaveBeenCalledWith(
      new URL(
        'http://keycloak:8080/realms/ekumetrics/protocol/openid-connect/certs',
      ),
    );
    expect(verify).toHaveBeenCalledWith('signed-token', 'trusted-jwks', {
      issuer: 'https://identity.example/realms/ekumetrics',
      audience: 'portal-web',
      algorithms: ['RS256'],
    });
  });

  it('rejects an ID token even when its signature is valid', async () => {
    verify.mockResolvedValueOnce({
      payload: {
        typ: 'ID',
        email: 'operator@example.test',
        realm_access: { roles: ['operator'] },
      },
      protectedHeader: { alg: 'RS256' },
      key: {} as never,
    });
    const service = new AuthService(
      config as never,
      kiosk as never,
      prisma as never,
      identity as never,
      keycloak as never,
    );

    await expect(service.verify('Bearer id-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('creates a BFF session from Keycloak password grant', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'signed-token',
          refresh_token: 'refresh-token',
          id_token: 'id-token',
        }),
    });
    const service = new AuthService(
      config as never,
      kiosk as never,
      prisma as never,
      identity as never,
      keycloak as never,
    );
    const response = { cookie: jest.fn() };

    await expect(
      service.loginWithPassword(
        { headers: { origin: 'https://monitoring.example' } } as never,
        response as never,
        {
          email: 'operator@example.test',
          password: 'secret',
          redirect: '/administracion/usuarios',
        },
      ),
    ).resolves.toMatchObject({
      user: { email: 'operator@example.test', role: 'operator' },
      redirect: '/administracion/usuarios',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://keycloak:8080/realms/ekumetrics/protocol/openid-connect/token',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(request.body).toBeInstanceOf(URLSearchParams);
    expect((request.body as URLSearchParams).get('grant_type')).toBe(
      'password',
    );
    expect(prisma.webSession.create).toHaveBeenCalled();
    expect(response.cookie).toHaveBeenCalledWith(
      'eku_session',
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    );
  });

  it('rejects password grant from a foreign origin', async () => {
    const service = new AuthService(
      config as never,
      kiosk as never,
      prisma as never,
      identity as never,
      keycloak as never,
    );

    await expect(
      service.loginWithPassword(
        { headers: { origin: 'https://evil.example' } } as never,
        { cookie: jest.fn() } as never,
        { email: 'operator@example.test', password: 'secret' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a server-side PKCE transaction with an exact API callback', () => {
    const service = new AuthService(
      config as never,
      kiosk as never,
      prisma as never,
      identity as never,
      keycloak as never,
    );
    const response = { cookie: jest.fn() };

    const authorizationUrl = new URL(
      service.beginLogin(response as never, '/administracion/usuarios'),
    );

    expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(
      'https://api.example/v1/auth/callback',
    );
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe(
      'S256',
    );
    expect(authorizationUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(response.cookie).toHaveBeenCalledWith(
      'eku_login',
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    );
  });

  it('rejects a state-changing cookie session without the bound CSRF token', async () => {
    const service = new AuthService(
      config as never,
      kiosk as never,
      prisma as never,
      identity as never,
      keycloak as never,
    );
    jest.spyOn(service as never, 'decrypt').mockReturnValue({
      tokens: { access_token: 'signed-token', refresh_token: 'refresh-token' },
      csrfToken: 'expected-csrf',
    });
    prisma.webSession.findUnique.mockResolvedValue({
      sessionHash: 'hash',
      encryptedTokens: 'encrypted',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(),
    });

    await expect(
      service.authenticate({
        method: 'POST',
        headers: {
          cookie: 'eku_session=opaque-id',
          origin: 'https://monitoring.example',
        },
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    [
      'idle timeout',
      new Date(Date.now() - 31 * 60_000),
      new Date(Date.now() + 60_000),
    ],
    ['absolute lifetime', new Date(), new Date(Date.now() - 1)],
  ])(
    'invalidates a session after its %s',
    async (_case, lastSeenAt, expiresAt) => {
      const service = new AuthService(
        config as never,
        kiosk as never,
        prisma as never,
        identity as never,
        keycloak as never,
      );
      prisma.webSession.findUnique.mockResolvedValue({
        sessionHash: 'hash',
        encryptedTokens: 'encrypted',
        revokedAt: null,
        expiresAt,
        lastSeenAt,
      });

      await expect(
        service.authenticate({
          method: 'GET',
          headers: { cookie: 'eku_session=opaque-id' },
        } as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.webSession.delete).toHaveBeenCalledWith({
        where: { sessionHash: 'hash' },
      });
    },
  );
});
