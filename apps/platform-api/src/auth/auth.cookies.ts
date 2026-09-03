import type { Request, Response } from 'express';

export function sessionCookieName(): string {
  return process.env.DEPLOYMENT_MODE === 'production'
    ? '__Host-eku_session'
    : 'eku_session';
}

export function mfaCookieName(): string {
  return process.env.DEPLOYMENT_MODE === 'production'
    ? '__Host-eku_mfa'
    : 'eku_mfa';
}

export function loginCookieName(): string {
  return process.env.DEPLOYMENT_MODE === 'production'
    ? '__Host-eku_login'
    : 'eku_login';
}

export function cookieValue(request: Request, name: string): string {
  const cookies = request.headers.cookie ?? '';
  for (const part of cookies.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key === name)
      return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return '';
}

export function setHttpOnlyCookie(
  response: Response,
  name: string,
  value: string,
  maxAge: number,
): void {
  response.cookie(name, value, {
    httpOnly: true,
    secure: process.env.DEPLOYMENT_MODE === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
}

export function clearHttpOnlyCookie(response: Response, name: string): void {
  response.clearCookie(name, {
    httpOnly: true,
    secure: process.env.DEPLOYMENT_MODE === 'production',
    sameSite: 'lax',
    path: '/',
  });
}
