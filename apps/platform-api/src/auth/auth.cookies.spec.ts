import type { Request, Response } from 'express';
import {
  cookieValue,
  loginCookieName,
  sessionCookieName,
  setHttpOnlyCookie,
} from './auth.cookies';

describe('BFF cookie policy', () => {
  const previousMode = process.env.DEPLOYMENT_MODE;

  afterEach(() => {
    if (previousMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = previousMode;
  });

  it('uses __Host, Secure, HttpOnly and SameSite in production', () => {
    process.env.DEPLOYMENT_MODE = 'production';
    const response = { cookie: jest.fn() };

    setHttpOnlyCookie(response as never, sessionCookieName(), 'opaque', 60_000);

    expect(sessionCookieName()).toBe('__Host-eku_session');
    expect(loginCookieName()).toBe('__Host-eku_login');
    expect(response.cookie).toHaveBeenCalledWith(
      '__Host-eku_session',
      'opaque',
      {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60_000,
      },
    );
  });

  it('parses a named cookie without accepting a partial name', () => {
    const request = {
      headers: { cookie: 'not_eku_session=wrong; eku_session=opaque%20id' },
    } as Request;

    expect(cookieValue(request, 'eku_session')).toBe('opaque id');
  });
});
