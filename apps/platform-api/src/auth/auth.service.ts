import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { Request, Response } from 'express';
import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import { Secret, TOTP } from 'otpauth';
import QRCode from 'qrcode';
import { KioskService } from '../kiosk/kiosk.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantIdentityService } from './tenant-identity.service';
import { KeycloakAdminService } from './keycloak-admin';
import {
  clearHttpOnlyCookie,
  cookieValue,
  loginCookieName,
  mfaCookieName,
  sessionCookieName,
  setHttpOnlyCookie,
} from './auth.cookies';
import type { AuthRole, AuthUser } from './auth.types';

const LOGIN_TTL_MS = 10 * 60 * 1000;
const MFA_SETUP_TTL_MS = 10 * 60 * 1000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
const REFRESH_BEFORE_SECONDS = 120;
const MAX_CONCURRENT_SESSIONS = 5;

type TokenSet = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
};

type LoginTransaction = {
  state: string;
  verifier: string;
  redirect: string;
  issuedAt: number;
};

export type AuthenticatedSession = {
  user: AuthUser;
  csrfToken: string;
  mfaEnrollmentRequired?: boolean;
};

type MfaSetup = {
  secret: string;
  algorithm: 'SHA1' | 'SHA256';
  digits: number;
  period: number;
  issuedAt: number;
};

@Injectable()
export class AuthService {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly kiosk: KioskService,
    private readonly prisma: PrismaService,
    private readonly identity: TenantIdentityService,
    private readonly keycloak: KeycloakAdminService,
  ) {}

  async loginOptions(email: string) {
    const normalized = String(email ?? '').trim().toLowerCase();
    const options = await this.identity.optionsForEmail(normalized);
    return {
      ...options,
      totpEnrolled: options.mfaRequired
        ? await this.keycloak.hasOtp(normalized)
        : false,
    };
  }

  async beginBroker(
    response: Response,
    email: string,
    redirect?: string,
  ): Promise<string> {
    const options = await this.loginOptions(email);
    if (!options.idpHint) {
      throw new BadRequestException(
        'Este correo no tiene un proveedor Entra ID configurado.',
      );
    }
    return this.beginLogin(response, redirect, options.idpHint);
  }

  async loginWithPassword(
    request: Request,
    response: Response,
    body: { email?: string; password?: string; totp?: string; redirect?: string },
  ): Promise<AuthenticatedSession & { redirect: string }> {
    if (!this.isPortalOrigin(String(request.headers.origin ?? ''))) {
      throw new ForbiddenException('Origen no permitido.');
    }
    const email = String(body.email ?? '').trim();
    const password = String(body.password ?? '');
    const totp = String(body.totp ?? '').trim();
    if (!email || !password) {
      throw new BadRequestException('Indique correo y contraseña.');
    }
    const options = await this.loginOptions(email);
    const enrolled = options.totpEnrolled;
    if (options.mfaRequired && enrolled && !totp) {
      throw new BadRequestException('Indique el código MFA.');
    }
    const tokens = await this.passwordGrantWithEnrollment(
      email,
      password,
      enrolled ? totp : '',
      options.mfaRequired && !enrolled,
    );
    const session = await this.establishSession(response, tokens);
    return {
      ...session,
      redirect:
        session.mfaEnrollmentRequired
          ? '/enrolar-mfa'
          : this.safeApplicationPath(body.redirect),
    };
  }

  beginLogin(response: Response, redirect?: string, idpHint?: string): string {
    const state = this.randomToken();
    const verifier = this.randomToken();
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const transaction: LoginTransaction = {
      state,
      verifier,
      redirect: this.safeApplicationPath(redirect),
      issuedAt: Date.now(),
    };
    setHttpOnlyCookie(
      response,
      loginCookieName(),
      this.encrypt(transaction),
      LOGIN_TTL_MS,
    );
    const params = new URLSearchParams({
      client_id: this.clientId(),
      redirect_uri: this.callbackUrl(),
      response_type: 'code',
      scope: 'openid profile email',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (idpHint) params.set('kc_idp_hint', idpHint);
    return `${this.issuerUrl()}/realms/${this.realm()}/protocol/openid-connect/auth?${params}`;
  }

  async completeLogin(
    request: Request,
    response: Response,
    code?: string,
    state?: string,
  ): Promise<string> {
    const raw = cookieValue(request, loginCookieName());
    clearHttpOnlyCookie(response, loginCookieName());
    if (!raw || !code || !state) {
      throw new BadRequestException(
        'La respuesta de autenticación está incompleta.',
      );
    }
    const transaction = this.decrypt<LoginTransaction>(raw);
    if (
      !transaction ||
      Date.now() - transaction.issuedAt > LOGIN_TTL_MS ||
      !this.equal(state, transaction.state)
    ) {
      throw new BadRequestException(
        'La transacción de autenticación expiró o no coincide.',
      );
    }
    const tokens = await this.exchangeCode(code, transaction.verifier);
    await this.establishSession(response, tokens);
    return `${this.portalUrl()}${transaction.redirect}`;
  }

  private async establishSession(
    response: Response,
    tokens: TokenSet,
  ): Promise<AuthenticatedSession> {
    const payload = await this.verifyAccessToken(tokens.access_token);
    const subject = String(payload.sub ?? '').trim();
    if (!subject)
      throw new UnauthorizedException('El token no identifica al usuario.');
    const sessionId = this.randomToken();
    const csrfToken = this.randomToken();
    await this.prisma.webSession.deleteMany({
      where: {
        OR: [{ expiresAt: { lte: new Date() } }, { revokedAt: { not: null } }],
      },
    });
    await this.prisma.webSession.create({
      data: {
        sessionHash: this.hash(sessionId),
        encryptedTokens: this.encrypt({ tokens, csrfToken }),
        subject,
        expiresAt: new Date(Date.now() + SESSION_MAX_MS),
      },
    });
    const excess = await this.prisma.webSession.findMany({
      where: { subject, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      skip: MAX_CONCURRENT_SESSIONS,
      select: { sessionHash: true },
    });
    if (excess.length) {
      await this.prisma.webSession.deleteMany({
        where: { sessionHash: { in: excess.map((item) => item.sessionHash) } },
      });
    }
    setHttpOnlyCookie(response, sessionCookieName(), sessionId, SESSION_MAX_MS);
    const user = this.toUser(payload);
    return {
      user,
      csrfToken,
      mfaEnrollmentRequired: await this.mfaEnrollmentRequired(user.email),
    };
  }

  async authenticate(request: Request): Promise<AuthenticatedSession> {
    const authorization = request.headers.authorization;
    if (this.bearer(authorization)) {
      return { user: await this.verify(authorization), csrfToken: '' };
    }
    const sessionId = cookieValue(request, sessionCookieName());
    if (!sessionId) throw new UnauthorizedException('Inicie sesión.');
    const session = await this.prisma.webSession.findUnique({
      where: { sessionHash: this.hash(sessionId) },
    });
    const now = Date.now();
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= now ||
      session.lastSeenAt.getTime() + SESSION_IDLE_MS <= now
    ) {
      if (session) {
        await this.prisma.webSession.delete({
          where: { sessionHash: session.sessionHash },
        });
      }
      throw new UnauthorizedException('La sesión expiró.');
    }
    const stored = this.decrypt<{ tokens: TokenSet; csrfToken: string }>(
      session.encryptedTokens,
    );
    if (!stored) throw new UnauthorizedException('La sesión no es válida.');
    this.validateCsrf(request, stored.csrfToken);
    const tokens = await this.refreshIfNeeded(stored.tokens);
    const payload = await this.verifyAccessToken(tokens.access_token);
    await this.prisma.webSession.update({
      where: { sessionHash: session.sessionHash },
      data: {
        lastSeenAt: new Date(),
        ...(tokens !== stored.tokens
          ? {
              encryptedTokens: this.encrypt({
                tokens,
                csrfToken: stored.csrfToken,
              }),
            }
          : {}),
      },
    });
    return { user: this.toUser(payload), csrfToken: stored.csrfToken };
  }

  async mfaEnrollmentRequired(email: string): Promise<boolean> {
    const options = await this.loginOptions(email);
    return options.mfaRequired && !options.totpEnrolled;
  }

  async beginMfaSetup(user: AuthUser, response: Response) {
    if (!(await this.mfaEnrollmentRequired(user.email))) {
      throw new BadRequestException('Esta cuenta ya no requiere enrolamiento MFA.');
    }
    const policy = await this.keycloak.otpPolicy();
    const secret = new Secret({ size: 20 });
    const totp = new TOTP({
      issuer: 'Ekumetrics',
      label: user.email,
      algorithm: policy.algorithm,
      digits: policy.digits,
      period: policy.period,
      secret,
    });
    const setup: MfaSetup = {
      secret: secret.base32,
      algorithm: policy.algorithm,
      digits: policy.digits,
      period: policy.period,
      issuedAt: Date.now(),
    };
    setHttpOnlyCookie(
      response,
      mfaCookieName(),
      this.encrypt(setup),
      MFA_SETUP_TTL_MS,
    );
    return {
      otpauthUrl: totp.toString(),
      secret: secret.base32,
      qrDataUrl: await QRCode.toDataURL(totp.toString(), {
        margin: 1,
        width: 192,
        errorCorrectionLevel: 'M',
      }),
    };
  }

  async confirmMfaSetup(
    request: Request,
    response: Response,
    user: AuthUser,
    totpInput?: string,
  ) {
    const code = String(totpInput ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) {
      throw new BadRequestException('Indique el código de 6 dígitos.');
    }
    const raw = cookieValue(request, mfaCookieName());
    const setup = raw ? this.decrypt<MfaSetup>(raw) : null;
    if (!setup || Date.now() - setup.issuedAt > MFA_SETUP_TTL_MS) {
      throw new BadRequestException(
        'El enrolamiento expiró. Genere un código QR de nuevo.',
      );
    }
    const totp = new TOTP({
      issuer: 'Ekumetrics',
      label: user.email,
      algorithm: setup.algorithm,
      digits: setup.digits,
      period: setup.period,
      secret: Secret.fromBase32(setup.secret),
    });
    if (totp.validate({ token: code, window: 1 }) === null) {
      throw new BadRequestException('El código MFA no es válido.');
    }
    await this.keycloak.registerOtp(user.email, setup.secret, {
      algorithm: setup.algorithm,
      digits: setup.digits,
      period: setup.period,
    });
    clearHttpOnlyCookie(response, mfaCookieName());
    return { enrolled: true };
  }

  async logout(
    request: Request,
    response: Response,
  ): Promise<{ logoutUrl: string }> {
    const sessionId = cookieValue(request, sessionCookieName());
    let idToken = '';
    if (sessionId) {
      const sessionHash = this.hash(sessionId);
      const session = await this.prisma.webSession.findUnique({
        where: { sessionHash },
      });
      const stored = session
        ? this.decrypt<{ tokens: TokenSet; csrfToken: string }>(
            session.encryptedTokens,
          )
        : null;
      idToken = stored?.tokens.id_token ?? '';
      if (stored?.tokens.refresh_token)
        await this.revoke(stored.tokens.refresh_token);
      await this.prisma.webSession.deleteMany({ where: { sessionHash } });
    }
    clearHttpOnlyCookie(response, sessionCookieName());
    const params = new URLSearchParams({
      client_id: this.clientId(),
      post_logout_redirect_uri: `${this.portalUrl()}/login`,
    });
    if (idToken) params.set('id_token_hint', idToken);
    return {
      logoutUrl: `${this.issuerUrl()}/realms/${this.realm()}/protocol/openid-connect/logout?${params}`,
    };
  }

  async verify(authorization?: string): Promise<AuthUser> {
    const token = this.bearer(authorization);
    if (!token) throw new UnauthorizedException('Inicie sesión.');
    try {
      if (decodeJwt(token).iss === 'ekumetrics:kiosk') {
        return this.kiosk.verifyAccessToken(token);
      }
    } catch {
      throw new UnauthorizedException('Sesión inválida o expirada.');
    }
    return this.toUser(await this.verifyAccessToken(token));
  }

  private async verifyAccessToken(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.keys(), {
        issuer: `${this.issuerUrl()}/realms/${this.realm()}`,
        audience:
          this.config.get<string>('KEYCLOAK_AUDIENCE') || this.clientId(),
        algorithms: ['RS256'],
      });
      if (payload['typ'] !== 'Bearer') {
        throw new UnauthorizedException('El token no es un access token.');
      }
      return payload;
    } catch {
      throw new UnauthorizedException('Sesión inválida o expirada.');
    }
  }

  private async passwordGrantWithEnrollment(
    username: string,
    password: string,
    totp: string,
    allowUnenrolled: boolean,
  ): Promise<TokenSet> {
    try {
      return await this.passwordGrant(username, password, totp);
    } catch (error) {
      if (
        error instanceof UnauthorizedException &&
        String(error.message).includes('acción en el proveedor')
      ) {
        await this.keycloak.clearLoginBlockingActions(username);
        return this.passwordGrant(
          username,
          password,
          allowUnenrolled ? '' : totp,
        );
      }
      throw error;
    }
  }

  private async passwordGrant(
    username: string,
    password: string,
    totp = '',
  ): Promise<TokenSet> {
    const values: Record<string, string> = {
      grant_type: 'password',
      client_id: this.clientId(),
      username,
      password,
      scope: 'openid profile email',
    };
    if (totp) values.totp = totp;
    const response = await fetch(
      `${this.baseUrl()}/realms/${this.realm()}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values),
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        error_description?: string;
      };
      const description = String(body.error_description ?? '').toLowerCase();
      if (description.includes('not fully set up')) {
        throw new UnauthorizedException(
          'La cuenta requiere completar una acción en el proveedor de identidad.',
        );
      }
      if (body.error === 'invalid_grant') {
        throw new UnauthorizedException('Correo o contraseña incorrectos.');
      }
      throw new UnauthorizedException(
        'No fue posible autenticar con el proveedor de identidad.',
      );
    }
    const value = (await response.json()) as Partial<TokenSet>;
    if (!value.access_token || !value.refresh_token) {
      throw new UnauthorizedException(
        'Keycloak entregó una respuesta incompleta.',
      );
    }
    return value as TokenSet;
  }

  private async exchangeCode(
    code: string,
    verifier: string,
  ): Promise<TokenSet> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      client_id: this.clientId(),
      code,
      code_verifier: verifier,
      redirect_uri: this.callbackUrl(),
    });
  }

  private async refreshIfNeeded(tokens: TokenSet): Promise<TokenSet> {
    try {
      const exp = Number(decodeJwt(tokens.access_token).exp ?? 0);
      if (exp > Math.floor(Date.now() / 1000) + REFRESH_BEFORE_SECONDS)
        return tokens;
    } catch {
      throw new UnauthorizedException('La sesión no es válida.');
    }
    return this.tokenRequest({
      grant_type: 'refresh_token',
      client_id: this.clientId(),
      refresh_token: tokens.refresh_token,
    });
  }

  private async tokenRequest(
    values: Record<string, string>,
  ): Promise<TokenSet> {
    const response = await fetch(
      `${this.baseUrl()}/realms/${this.realm()}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values),
      },
    );
    if (!response.ok)
      throw new UnauthorizedException('Keycloak rechazó la sesión.');
    const value = (await response.json()) as Partial<TokenSet>;
    if (!value.access_token || !value.refresh_token) {
      throw new UnauthorizedException(
        'Keycloak entregó una respuesta incompleta.',
      );
    }
    return value as TokenSet;
  }

  private async revoke(refreshToken: string): Promise<void> {
    try {
      await fetch(
        `${this.baseUrl()}/realms/${this.realm()}/protocol/openid-connect/logout`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: this.clientId(),
            refresh_token: refreshToken,
          }),
        },
      );
    } catch {
      // La sesión local se elimina aun si Keycloak está temporalmente inaccesible.
    }
  }

  private validateCsrf(request: Request, expected: string): void {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase()))
      return;
    const supplied = String(request.headers['x-csrf-token'] ?? '');
    const origin = String(request.headers.origin ?? '');
    if (!this.equal(supplied, expected) || !this.isPortalOrigin(origin)) {
      throw new ForbiddenException('La validación CSRF falló.');
    }
  }

  private isPortalOrigin(origin: string): boolean {
    if (origin === this.portalUrl()) return true;
    try {
      const requested = new URL(origin);
      const portal = new URL(this.portalUrl());
      const loopback = (host: string) =>
        host === 'localhost' || host === '127.0.0.1';
      return (
        requested.protocol === portal.protocol &&
        requested.port === portal.port &&
        loopback(requested.hostname) &&
        loopback(portal.hostname)
      );
    } catch {
      return false;
    }
  }

  private keys() {
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(
        new URL(
          `${this.baseUrl()}/realms/${this.realm()}/protocol/openid-connect/certs`,
        ),
      );
    }
    return this.jwks;
  }

  private toUser(payload: JWTPayload): AuthUser {
    const roles = this.roles(payload);
    const role: AuthRole = roles.includes('operator')
      ? 'operator'
      : roles.includes('admin')
        ? 'admin'
        : 'viewer';
    const tenant = this.stringClaim(payload['tenant']) || 'default';
    const email =
      this.stringClaim(payload.email) ||
      this.stringClaim(payload.preferred_username);
    if (!email) throw new UnauthorizedException('El token no trae correo.');
    const name =
      [
        this.stringClaim(payload['given_name']),
        this.stringClaim(payload['family_name']),
      ]
        .filter(Boolean)
        .join(' ') || email;
    return { email, name, tenant, role };
  }

  private encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((part) => part.toString('base64url'))
      .join('.');
  }

  private decrypt<T>(value: string): T | null {
    try {
      const [iv, tag, ciphertext] = value
        .split('.')
        .map((part) => Buffer.from(part, 'base64url'));
      if (!iv || !tag || !ciphertext) return null;
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey(),
        iv,
      );
      decipher.setAuthTag(tag);
      return JSON.parse(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
          'utf8',
        ),
      ) as T;
    } catch {
      return null;
    }
  }

  private encryptionKey(): Buffer {
    const secret = this.config.get<string>('BFF_SESSION_SECRET') ?? '';
    if (secret.length < 32) {
      throw new Error('BFF_SESSION_SECRET debe tener al menos 32 caracteres.');
    }
    return createHash('sha256').update(secret).digest();
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private equal(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private randomToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private safeApplicationPath(value?: string): string {
    return value?.startsWith('/') && !value.startsWith('//') ? value : '/hosts';
  }

  private bearer(authorization?: string): string {
    const value = (authorization ?? '').trim();
    return value.toLowerCase().startsWith('bearer ')
      ? value.slice(7).trim()
      : '';
  }

  private issuerUrl(): string {
    return (
      this.config.get<string>('KEYCLOAK_URL') ?? 'http://localhost:8080'
    ).replace(/\/$/, '');
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('KEYCLOAK_INTERNAL_URL') ?? this.issuerUrl()
    ).replace(/\/$/, '');
  }

  private portalUrl(): string {
    return (
      this.config.get<string>('PORTAL_PUBLIC_URL') ?? 'http://localhost:4200'
    ).replace(/\/$/, '');
  }

  private callbackUrl(): string {
    const api = (
      this.config.get<string>('API_PUBLIC_URL') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');
    return `${api}/v1/auth/callback`;
  }

  private clientId(): string {
    return this.config.get<string>('KEYCLOAK_CLIENT_ID') ?? 'portal-web';
  }

  private realm(): string {
    return this.config.get<string>('KEYCLOAK_REALM') ?? 'ekumetrics';
  }

  private stringClaim(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private roles(payload: JWTPayload): string[] {
    const realm = payload['realm_access'] as { roles?: string[] } | undefined;
    return realm?.roles ?? [];
  }
}
