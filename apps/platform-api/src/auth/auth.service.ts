import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { PrismaService } from '../prisma/prisma.service';
import { KeycloakAdminService } from './keycloak-admin';
import type { AuthRole, AuthUser } from './auth.types';

@Injectable()
export class AuthService {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly keycloak: KeycloakAdminService,
  ) {}

  async passwordLogin(emailInput?: string, passwordInput?: string) {
    const email = (emailInput ?? '').trim().toLowerCase();
    const tokens = await this.grant(email, passwordInput ?? '');
    if (await this.needsPasswordChange(email)) {
      return { requiresPasswordChange: true };
    }
    return tokens;
  }

  async changeFirstPassword(
    emailInput?: string,
    currentInput?: string,
    nextInput?: string,
    confirmInput?: string,
  ) {
    const email = (emailInput ?? '').trim().toLowerCase();
    const current = currentInput ?? '';
    const next = nextInput ?? '';
    const confirm = confirmInput ?? '';
    if (!email || !current || !next) {
      throw new BadRequestException('Complete el correo, la contraseña actual y la nueva.');
    }
    if (next.length < 8) {
      throw new BadRequestException('La contraseña debe tener al menos 8 caracteres.');
    }
    if (next !== confirm) {
      throw new BadRequestException('Las contraseñas no coinciden.');
    }
    if (next === current) {
      throw new BadRequestException('La nueva contraseña debe ser distinta a la temporal.');
    }
    if (!(await this.needsPasswordChange(email))) {
      throw new BadRequestException('Esta cuenta no tiene un cambio de contraseña pendiente.');
    }
    await this.grant(email, current);
    await this.keycloak.setPassword(email, next);
    await this.prisma.user.updateMany({
      where: { email },
      data: { mustChangePassword: false },
    });
    return this.grant(email, next);
  }

  private async needsPasswordChange(email: string): Promise<boolean> {
    const pending = await this.prisma.user.findFirst({
      where: { email, mustChangePassword: true },
    });
    return !!pending;
  }

  private async grant(email: string, password: string) {
    if (!email || !password) {
      throw new UnauthorizedException('Ingrese su correo electrónico y contraseña.');
    }
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: this.config.get<string>('KEYCLOAK_AUDIENCE') || 'portal-web',
      username: email,
      password,
      scope: 'openid',
    });
    const response = await fetch(
      `${this.baseUrl()}/realms/${this.realm()}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
    );
    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
    };
    if (!response.ok || !payload.access_token) {
      throw new UnauthorizedException('Las credenciales no son válidas.');
    }
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token ?? '',
      id_token: payload.id_token ?? '',
    };
  }

  async verify(authorization?: string): Promise<AuthUser> {
    const token = this.bearer(authorization);
    if (!token) {
      throw new UnauthorizedException('Inicie sesion.');
    }
    const issuer = `${this.issuerUrl()}/realms/${this.realm()}`;
    try {
      const { payload } = await jwtVerify(token, this.keys(), {
        issuer,
        audience: this.config.get<string>('KEYCLOAK_AUDIENCE') || 'portal-web',
      });
      return this.toUser(payload);
    } catch {
      throw new UnauthorizedException('Sesion invalida o expirada.');
    }
  }

  private keys() {
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(
        new URL(`${this.baseUrl()}/realms/${this.realm()}/protocol/openid-connect/certs`),
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
    const tenant = String(payload['tenant'] ?? 'default').trim() || 'default';
    const email = String(payload.email ?? payload.preferred_username ?? '').trim();
    if (!email) {
      throw new UnauthorizedException('El token no trae correo.');
    }
    const name = [payload['given_name'], payload['family_name']].filter(Boolean).join(' ') || email;
    return { email, name: String(name), tenant, role };
  }

  private roles(payload: JWTPayload): string[] {
    const realm = payload['realm_access'] as { roles?: string[] } | undefined;
    return realm?.roles ?? [];
  }

  private bearer(authorization?: string): string {
    const value = (authorization ?? '').trim();
    return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
  }

  private issuerUrl(): string {
    return (this.config.get<string>('KEYCLOAK_URL') ?? 'http://localhost:8080').replace(/\/$/, '');
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('KEYCLOAK_INTERNAL_URL') ?? this.issuerUrl()
    ).replace(/\/$/, '');
  }

  private realm(): string {
    return this.config.get<string>('KEYCLOAK_REALM') ?? 'ekumetrics';
  }
}
