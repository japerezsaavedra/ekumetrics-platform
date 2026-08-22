import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';

type KeycloakUser = {
  id?: string;
  username?: string;
};

type KeycloakRole = {
  id: string;
  name: string;
};

@Injectable()
export class KeycloakAdminService {
  private token: { value: string; exp: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  async provisionUser(input: {
    email: string;
    displayName: string;
    role: string;
    tenant: string;
  }): Promise<string> {
    const password = this.temporaryPassword();
    const realm = this.realm();
    const token = await this.adminToken();
    const names = this.splitName(input.displayName);
    const created = await this.request(token, 'POST', `/admin/realms/${realm}/users`, {
      username: input.email,
      email: input.email,
      emailVerified: true,
      enabled: true,
      firstName: names.first,
      lastName: names.last,
      requiredActions: [],
      attributes: { tenant: [input.tenant] },
    });
    if (created.status === 409) {
      throw new ConflictException('Ese correo ya existe en Keycloak.');
    }
    if (created.status !== 201) {
      throw new ServiceUnavailableException('Keycloak no pudo crear el usuario.');
    }
    const userId = await this.findUserId(token, realm, input.email);
    if (!userId) {
      throw new ServiceUnavailableException('Keycloak creo el usuario pero no devolvio el id.');
    }
    const passwordRes = await this.request(token, 'PUT', `/admin/realms/${realm}/users/${userId}/reset-password`, {
      type: 'password',
      value: password,
      temporary: false,
    });
    if (passwordRes.status >= 400) {
      await this.request(token, 'DELETE', `/admin/realms/${realm}/users/${userId}`);
      throw new ServiceUnavailableException('Keycloak no pudo asignar la clave.');
    }
    await this.assignRole(token, realm, userId, input.role);
    return password;
  }

  async updateUser(email: string, displayName: string, role: string): Promise<void> {
    const realm = this.realm();
    const token = await this.adminToken();
    const userId = await this.findUserId(token, realm, email);
    if (!userId) {
      return;
    }
    const names = this.splitName(displayName);
    const response = await this.request(token, 'PUT', `/admin/realms/${realm}/users/${userId}`, {
      email,
      firstName: names.first,
      lastName: names.last,
    });
    if (response.status >= 400) {
      throw new ServiceUnavailableException('Keycloak no pudo actualizar el usuario.');
    }
    await this.replaceRole(token, realm, userId, role);
  }

  async deleteUser(email: string): Promise<void> {
    const realm = this.realm();
    const token = await this.adminToken();
    const userId = await this.findUserId(token, realm, email);
    if (!userId) {
      return;
    }
    await this.request(token, 'DELETE', `/admin/realms/${realm}/users/${userId}`);
  }

  async setPassword(email: string, password: string): Promise<void> {
    const realm = this.realm();
    const token = await this.adminToken();
    const userId = await this.findUserId(token, realm, email);
    if (!userId) {
      throw new ServiceUnavailableException('Keycloak no encontro el usuario.');
    }
    const response = await this.request(token, 'PUT', `/admin/realms/${realm}/users/${userId}/reset-password`, {
      type: 'password',
      value: password,
      temporary: false,
    });
    if (response.status >= 400) {
      throw new ServiceUnavailableException('Keycloak no pudo actualizar la clave.');
    }
  }

  private async replaceRole(token: string, realm: string, userId: string, roleName: string): Promise<void> {
    const current = await this.request(token, 'GET', `/admin/realms/${realm}/users/${userId}/role-mappings/realm`);
    const roles = ((await current.json().catch(() => [])) as KeycloakRole[]).filter(
      (item) => item.name === 'admin' || item.name === 'viewer' || item.name === 'operator',
    );
    if (roles.length) {
      await this.request(token, 'DELETE', `/admin/realms/${realm}/users/${userId}/role-mappings/realm`, roles);
    }
    await this.assignRole(token, realm, userId, roleName);
  }

  private async assignRole(token: string, realm: string, userId: string, roleName: string): Promise<void> {
    const role = roleName === 'operator' || roleName === 'admin' || roleName === 'viewer' ? roleName : 'viewer';
    const found = await this.request(token, 'GET', `/admin/realms/${realm}/roles/${role}`);
    if (found.status >= 400) {
      return;
    }
    const body = (await found.json()) as KeycloakRole;
    await this.request(token, 'POST', `/admin/realms/${realm}/users/${userId}/role-mappings/realm`, [
      { id: body.id, name: body.name },
    ]);
  }

  private async findUserId(token: string, realm: string, email: string): Promise<string | null> {
    const response = await this.request(
      token,
      'GET',
      `/admin/realms/${realm}/users?email=${encodeURIComponent(email)}&exact=true`,
    );
    const users = (await response.json().catch(() => [])) as KeycloakUser[];
    return users[0]?.id ?? null;
  }

  private async adminToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 5000) {
      return this.token.value;
    }
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: this.config.get<string>('KEYCLOAK_ADMIN') ?? 'admin',
      password: this.config.get<string>('KEYCLOAK_ADMIN_PASSWORD') ?? 'ekumetrics',
    });
    const response = await fetch(
      `${this.baseUrl()}/realms/${this.adminRealm()}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
    );
    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!response.ok || !payload.access_token) {
      throw new ServiceUnavailableException('No se pudo autenticar contra Keycloak admin.');
    }
    this.token = {
      value: payload.access_token,
      exp: Date.now() + (payload.expires_in ?? 60) * 1000,
    };
    return payload.access_token;
  }

  private async request(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${this.baseUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private temporaryPassword(): string {
    return `Eku-${randomBytes(6).toString('base64url')}`;
  }

  private splitName(displayName: string): { first: string; last: string } {
    const parts = displayName.trim().split(/\s+/);
    return { first: parts[0] || displayName, last: parts.slice(1).join(' ') };
  }

  private baseUrl(): string {
    return (this.config.get<string>('KEYCLOAK_URL') ?? 'http://localhost:8080').replace(/\/$/, '');
  }

  private realm(): string {
    return this.config.get<string>('KEYCLOAK_REALM') ?? 'ekumetrics';
  }

  private adminRealm(): string {
    return this.config.get<string>('KEYCLOAK_ADMIN_REALM') ?? 'master';
  }
}
