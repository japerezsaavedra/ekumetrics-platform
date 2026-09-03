import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';

type KeycloakUser = {
  id?: string;
  username?: string;
  requiredActions?: string[];
  attributes?: Record<string, string[]>;
};

type KeycloakRole = {
  id: string;
  name: string;
};

export function requiredActionsFor(_deploymentMode?: string): string[] {
  return [];
}

export function entraAlias(slug: string): string {
  return `eku-entra-${slug.replace(/[^a-z0-9-]/gi, '').toLowerCase()}`;
}

export function adComponentName(slug: string): string {
  return `eku-ad-${slug.replace(/[^a-z0-9-]/gi, '').toLowerCase()}`;
}

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
    const created = await this.request(
      token,
      'POST',
      `/admin/realms/${realm}/users`,
      {
        username: input.email,
        email: input.email,
        emailVerified: true,
        enabled: true,
        firstName: names.first,
        lastName: names.last,
        requiredActions: requiredActionsFor(
          this.config.get<string>('DEPLOYMENT_MODE'),
        ),
        attributes: { tenant: [input.tenant] },
      },
    );
    if (created.status === 409) {
      throw new ConflictException('Ese correo ya existe en Keycloak.');
    }
    if (created.status !== 201) {
      throw new ServiceUnavailableException(
        'Keycloak no pudo crear el usuario.',
      );
    }
    const userId = await this.findUserId(token, realm, input.email);
    if (!userId) {
      throw new ServiceUnavailableException(
        'Keycloak creo el usuario pero no devolvio el id.',
      );
    }
    const passwordRes = await this.request(
      token,
      'PUT',
      `/admin/realms/${realm}/users/${userId}/reset-password`,
      {
        type: 'password',
        value: password,
        temporary: false,
      },
    );
    if (passwordRes.status >= 400) {
      await this.request(
        token,
        'DELETE',
        `/admin/realms/${realm}/users/${userId}`,
      );
      throw new ServiceUnavailableException(
        'Keycloak no pudo asignar la clave.',
      );
    }
    await this.assignRole(token, realm, userId, input.role);
    await this.request(token, 'PUT', `/admin/realms/${realm}/users/${userId}`, {
      requiredActions: [],
    });
    return password;
  }

  async updateUser(
    email: string,
    displayName: string,
    role: string,
  ): Promise<void> {
    const realm = this.realm();
    const token = await this.adminToken();
    const userId = await this.findUserId(token, realm, email);
    if (!userId) {
      return;
    }
    const names = this.splitName(displayName);
    const response = await this.request(
      token,
      'PUT',
      `/admin/realms/${realm}/users/${userId}`,
      {
        email,
        firstName: names.first,
        lastName: names.last,
      },
    );
    if (response.status >= 400) {
      throw new ServiceUnavailableException(
        'Keycloak no pudo actualizar el usuario.',
      );
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
    await this.request(
      token,
      'DELETE',
      `/admin/realms/${realm}/users/${userId}`,
    );
  }

  async requireTotp(email: string): Promise<void> {
    await this.patchRequiredActions(email, true);
  }

  async clearTotpRequired(email: string): Promise<void> {
    await this.patchRequiredActions(email, false);
  }

  async clearLoginBlockingActions(email: string): Promise<void> {
    const realm = this.realm();
    const token = await this.adminToken();
    const userId = await this.findUserId(token, realm, email);
    if (!userId) return;
    const current = await this.request(
      token,
      'GET',
      `/admin/realms/${realm}/users/${userId}`,
    );
    if (current.status >= 400) return;
    await this.request(token, 'PUT', `/admin/realms/${realm}/users/${userId}`, {
      requiredActions: [],
    });
  }

  async applyTenantMfa(tenant: string, _required: boolean): Promise<void> {
    const realm = this.realm();
    const token = await this.adminToken();
    const users = await this.listTenantUsers(token, realm, tenant);
    for (const user of users) {
      if (!user.id) continue;
      await this.patchUserActions(token, realm, user.id, false);
    }
  }

  async hasOtp(email: string): Promise<boolean> {
    const realm = this.realm();
    const token = await this.adminToken();
    const userId = await this.findUserId(token, realm, email);
    if (!userId) return false;
    const response = await this.request(
      token,
      'GET',
      `/admin/realms/${realm}/users/${userId}/credentials`,
    );
    if (!response.ok) return false;
    const credentials = (await response.json()) as Array<{ type?: string }>;
    return credentials.some((item) => item.type === 'otp');
  }

  async otpPolicy(): Promise<{
    algorithm: 'SHA1' | 'SHA256';
    digits: number;
    period: number;
  }> {
    const realm = this.realm();
    const token = await this.adminToken();
    const response = await this.request(token, 'GET', `/admin/realms/${realm}`);
    if (!response.ok) {
      return { algorithm: 'SHA1', digits: 6, period: 30 };
    }
    const body = (await response.json()) as {
      otpPolicyAlgorithm?: string;
      otpPolicyDigits?: number;
      otpPolicyPeriod?: number;
    };
    return {
      algorithm: body.otpPolicyAlgorithm === 'HmacSHA256' ? 'SHA256' : 'SHA1',
      digits: Number(body.otpPolicyDigits ?? 6) || 6,
      period: Number(body.otpPolicyPeriod ?? 30) || 30,
    };
  }

  async registerOtp(
    email: string,
    secret: string,
    policy: { algorithm: 'SHA1' | 'SHA256'; digits: number; period: number },
  ): Promise<void> {
    const realm = this.realm();
    const token = await this.adminToken();
    const userId = await this.findUserId(token, realm, email);
    if (!userId) {
      throw new ServiceUnavailableException(
        'Keycloak no encontró el usuario para MFA.',
      );
    }
    const listed = await this.request(
      token,
      'GET',
      `/admin/realms/${realm}/users/${userId}/credentials`,
    );
    if (listed.ok) {
      const credentials = (await listed.json()) as Array<{
        id?: string;
        type?: string;
      }>;
      for (const item of credentials) {
        if (item.type === 'otp' && item.id) {
          await this.request(
            token,
            'DELETE',
            `/admin/realms/${realm}/users/${userId}/credentials/${item.id}`,
          );
        }
      }
    }
    const current = await this.request(
      token,
      'GET',
      `/admin/realms/${realm}/users/${userId}`,
    );
    if (!current.ok) {
      throw new ServiceUnavailableException(
        'Keycloak no pudo leer el usuario para MFA.',
      );
    }
    const user = (await current.json()) as KeycloakUser;
    const actions = (user.requiredActions ?? []).filter(
      (item) => item !== 'CONFIGURE_TOTP',
    );
    const updated = await this.request(
      token,
      'PUT',
      `/admin/realms/${realm}/users/${userId}`,
      {
        ...user,
        requiredActions: actions,
        credentials: [
          {
            type: 'otp',
            secret,
            temporary: false,
            userLabel: 'Ekumetrics',
            algorithm: policy.algorithm === 'SHA256' ? 'HmacSHA256' : 'HmacSHA1',
            digits: policy.digits,
            period: policy.period,
          },
        ],
      },
    );
    if (!updated.ok) {
      throw new ServiceUnavailableException(
        'Keycloak no pudo registrar el TOTP.',
      );
    }
  }

  async upsertEntraIdp(input: {
    slug: string;
    tenantId: string;
    clientId: string;
    clientSecret: string;
    enabled: boolean;
  }): Promise<void> {
    const realm = this.realm();
    const token = await this.adminToken();
    const alias = entraAlias(input.slug);
    const base = `https://login.microsoftonline.com/${input.tenantId}`;
    const payload = {
      alias,
      displayName: `Entra ID ${input.slug}`,
      providerId: 'oidc',
      enabled: input.enabled,
      trustEmail: true,
      storeToken: false,
      firstBrokerLoginFlowAlias: 'first broker login',
      config: {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        tokenUrl: `${base}/oauth2/v2.0/token`,
        authorizationUrl: `${base}/oauth2/v2.0/authorize`,
        userInfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
        issuer: `${base}/v2.0`,
        defaultScope: 'openid profile email',
        validateSignature: 'true',
        useJwksUrl: 'true',
        jwksUrl: `${base}/discovery/v2.0/keys`,
        syncMode: 'IMPORT',
        clientAuthMethod: 'client_secret_post',
      },
    };
    const current = await this.request(
      token,
      'GET',
      `/admin/realms/${realm}/identity-provider/instances/${alias}`,
    );
    const saved = await this.request(
      token,
      current.status === 200 ? 'PUT' : 'POST',
      current.status === 200
        ? `/admin/realms/${realm}/identity-provider/instances/${alias}`
        : `/admin/realms/${realm}/identity-provider/instances`,
      payload,
    );
    if (saved.status >= 400) {
      throw new ServiceUnavailableException(
        'Keycloak no pudo guardar el proveedor Entra ID.',
      );
    }
    await this.ensureIdpMappers(token, realm, alias, input.slug);
  }

  async removeEntraIdp(slug: string): Promise<void> {
    const realm = this.realm();
    const token = await this.adminToken();
    await this.request(
      token,
      'DELETE',
      `/admin/realms/${realm}/identity-provider/instances/${entraAlias(slug)}`,
    );
  }

  async upsertAdFederation(input: {
    slug: string;
    connectionUrl: string;
    bindDn: string;
    bindPassword: string;
    usersDn: string;
    enabled: boolean;
  }): Promise<void> {
    const realm = this.realm();
    const token = await this.adminToken();
    const realmId = await this.realmId(token, realm);
    const name = adComponentName(input.slug);
    const existing = await this.findComponent(token, realm, realmId, name);
    const payload = {
      name,
      providerId: 'ldap',
      providerType: 'org.keycloak.storage.UserStorageProvider',
      parentId: realmId,
      config: {
        enabled: [String(input.enabled)],
        vendor: ['ad'],
        connectionUrl: [input.connectionUrl],
        bindDn: [input.bindDn],
        bindCredential: [input.bindPassword],
        usersDn: [input.usersDn],
        usernameLDAPAttribute: ['mail'],
        rdnLDAPAttribute: ['cn'],
        uuidLDAPAttribute: ['objectGUID'],
        userObjectClasses: ['person, organizationalPerson, user'],
        editMode: ['READ_ONLY'],
        importEnabled: ['true'],
        syncRegistrations: ['false'],
        pagination: ['true'],
        batchSizeForSync: ['1000'],
        fullSyncPeriod: ['-1'],
        changedSyncPeriod: ['-1'],
        priority: ['0'],
        searchScope: ['2'],
        authType: ['simple'],
        startTls: ['false'],
        useTruststoreSpi: ['ldapsOnly'],
        connectionPooling: ['true'],
        allowKerberosAuthentication: ['false'],
        useKerberosForPasswordAuthentication: ['false'],
        cachePolicy: ['DEFAULT'],
      },
    };
    const saved = await this.request(
      token,
      existing ? 'PUT' : 'POST',
      existing
        ? `/admin/realms/${realm}/components/${existing}`
        : `/admin/realms/${realm}/components`,
      existing ? { ...payload, id: existing } : payload,
    );
    if (saved.status >= 400) {
      throw new ServiceUnavailableException(
        'Keycloak no pudo guardar la federación de Active Directory.',
      );
    }
    const componentId =
      existing ||
      (await this.findComponent(token, realm, realmId, name)) ||
      '';
    if (componentId) {
      await this.ensureLdapTenantMapper(token, realm, componentId, input.slug);
    }
  }

  async removeAdFederation(slug: string): Promise<void> {
    const realm = this.realm();
    const token = await this.adminToken();
    const realmId = await this.realmId(token, realm);
    const id = await this.findComponent(
      token,
      realm,
      realmId,
      adComponentName(slug),
    );
    if (!id) return;
    await this.request(
      token,
      'DELETE',
      `/admin/realms/${realm}/components/${id}`,
    );
  }

  async resetPassword(email: string): Promise<string> {
    const password = this.temporaryPassword();
    await this.setPassword(email, password);
    return password;
  }

  async setPassword(email: string, password: string): Promise<void> {
    const realm = this.realm();
    const token = await this.adminToken();
    const userId = await this.findUserId(token, realm, email);
    if (!userId) {
      throw new ServiceUnavailableException('Keycloak no encontro el usuario.');
    }
    const response = await this.request(
      token,
      'PUT',
      `/admin/realms/${realm}/users/${userId}/reset-password`,
      {
        type: 'password',
        value: password,
        temporary: false,
      },
    );
    if (response.status >= 400) {
      throw new ServiceUnavailableException(
        'Keycloak no pudo actualizar la clave.',
      );
    }
  }

  private async replaceRole(
    token: string,
    realm: string,
    userId: string,
    roleName: string,
  ): Promise<void> {
    const current = await this.request(
      token,
      'GET',
      `/admin/realms/${realm}/users/${userId}/role-mappings/realm`,
    );
    const roles = (
      (await current.json().catch(() => [])) as KeycloakRole[]
    ).filter(
      (item) =>
        item.name === 'admin' ||
        item.name === 'viewer' ||
        item.name === 'operator',
    );
    if (roles.length) {
      await this.request(
        token,
        'DELETE',
        `/admin/realms/${realm}/users/${userId}/role-mappings/realm`,
        roles,
      );
    }
    await this.assignRole(token, realm, userId, roleName);
  }

  private async assignRole(
    token: string,
    realm: string,
    userId: string,
    roleName: string,
  ): Promise<void> {
    const role =
      roleName === 'operator' || roleName === 'admin' || roleName === 'viewer'
        ? roleName
        : 'viewer';
    const found = await this.request(
      token,
      'GET',
      `/admin/realms/${realm}/roles/${role}`,
    );
    if (found.status >= 400) {
      return;
    }
    const body = (await found.json()) as KeycloakRole;
    await this.request(
      token,
      'POST',
      `/admin/realms/${realm}/users/${userId}/role-mappings/realm`,
      [{ id: body.id, name: body.name }],
    );
  }

  private async patchRequiredActions(
    email: string,
    requireTotp: boolean,
  ): Promise<void> {
    const realm = this.realm();
    const token = await this.adminToken();
    const userId = await this.findUserId(token, realm, email);
    if (!userId) return;
    await this.patchUserActions(token, realm, userId, requireTotp);
  }

  private async patchUserActions(
    token: string,
    realm: string,
    userId: string,
    requireTotp: boolean,
  ): Promise<void> {
    const current = await this.request(
      token,
      'GET',
      `/admin/realms/${realm}/users/${userId}`,
    );
    if (current.status >= 400) return;
    const user = (await current.json()) as KeycloakUser;
    const actions = new Set(user.requiredActions ?? []);
    if (requireTotp) actions.add('CONFIGURE_TOTP');
    else actions.delete('CONFIGURE_TOTP');
    await this.request(token, 'PUT', `/admin/realms/${realm}/users/${userId}`, {
      requiredActions: [...actions],
    });
  }

  private async listTenantUsers(
    token: string,
    realm: string,
    tenant: string,
  ): Promise<KeycloakUser[]> {
    const response = await this.request(
      token,
      'GET',
      `/admin/realms/${realm}/users?q=${encodeURIComponent(`tenant:${tenant}`)}&max=200`,
    );
    return ((await response.json().catch(() => [])) as KeycloakUser[]) ?? [];
  }

  private async ensureIdpMappers(
    token: string,
    realm: string,
    alias: string,
    slug: string,
  ): Promise<void> {
    const list = await this.request(
      token,
      'GET',
      `/admin/realms/${realm}/identity-provider/instances/${alias}/mappers`,
    );
    const mappers = ((await list.json().catch(() => [])) as Array<{ name?: string }>) ?? [];
    if (!mappers.some((item) => item.name === 'tenant')) {
      await this.request(
        token,
        'POST',
        `/admin/realms/${realm}/identity-provider/instances/${alias}/mappers`,
        {
          name: 'tenant',
          identityProviderAlias: alias,
          identityProviderMapper: 'hardcoded-attribute-idp-mapper',
          config: {
            syncMode: 'INHERIT',
            attribute: 'tenant',
            'attribute.value': slug,
          },
        },
      );
    }
    if (!mappers.some((item) => item.name === 'viewer-role')) {
      await this.request(
        token,
        'POST',
        `/admin/realms/${realm}/identity-provider/instances/${alias}/mappers`,
        {
          name: 'viewer-role',
          identityProviderAlias: alias,
          identityProviderMapper: 'oidc-hardcoded-role-idp-mapper',
          config: { role: 'viewer' },
        },
      );
    }
  }

  private async realmId(token: string, realm: string): Promise<string> {
    const response = await this.request(
      token,
      'GET',
      `/admin/realms/${realm}`,
    );
    const body = (await response.json().catch(() => ({}))) as { id?: string };
    if (!body.id) {
      throw new ServiceUnavailableException('Keycloak no entregó el id del realm.');
    }
    return body.id;
  }

  private async findComponent(
    token: string,
    realm: string,
    parentId: string,
    name: string,
  ): Promise<string | null> {
    const response = await this.request(
      token,
      'GET',
      `/admin/realms/${realm}/components?parent=${encodeURIComponent(parentId)}&type=${encodeURIComponent('org.keycloak.storage.UserStorageProvider')}`,
    );
    const items = ((await response.json().catch(() => [])) as Array<{
      id?: string;
      name?: string;
    }>) ?? [];
    return items.find((item) => item.name === name)?.id ?? null;
  }

  private async ensureLdapTenantMapper(
    token: string,
    realm: string,
    parentId: string,
    slug: string,
  ): Promise<void> {
    const response = await this.request(
      token,
      'GET',
      `/admin/realms/${realm}/components?parent=${encodeURIComponent(parentId)}&type=${encodeURIComponent('org.keycloak.storage.ldap.mappers.LDAPStorageMapper')}`,
    );
    const items = ((await response.json().catch(() => [])) as Array<{
      name?: string;
    }>) ?? [];
    if (items.some((item) => item.name === 'tenant')) return;
    await this.request(token, 'POST', `/admin/realms/${realm}/components`, {
      name: 'tenant',
      providerId: 'hardcoded-attribute-mapper',
      providerType: 'org.keycloak.storage.ldap.mappers.LDAPStorageMapper',
      parentId,
      config: {
        'user.model.attribute': ['tenant'],
        'attribute.value': [slug],
      },
    });
  }

  private async findUserId(
    token: string,
    realm: string,
    email: string,
  ): Promise<string | null> {
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
      password:
        this.config.get<string>('KEYCLOAK_ADMIN_PASSWORD') ?? 'ekumetrics',
    });
    const response = await fetch(
      `${this.baseUrl()}/realms/${this.adminRealm()}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
    );
    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!response.ok || !payload.access_token) {
      throw new ServiceUnavailableException(
        'No se pudo autenticar contra Keycloak admin.',
      );
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
    return `Eku-${randomBytes(18).toString('base64url')}`;
  }

  private splitName(displayName: string): { first: string; last: string } {
    const parts = displayName.trim().split(/\s+/);
    return { first: parts[0] || displayName, last: parts.slice(1).join(' ') };
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('KEYCLOAK_INTERNAL_URL') ??
      this.config.get<string>('KEYCLOAK_URL') ??
      'http://localhost:8080'
    ).replace(/\/$/, '');
  }

  private realm(): string {
    return this.config.get<string>('KEYCLOAK_REALM') ?? 'ekumetrics';
  }

  private adminRealm(): string {
    return this.config.get<string>('KEYCLOAK_ADMIN_REALM') ?? 'master';
  }
}
