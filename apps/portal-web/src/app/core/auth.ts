import { Injectable, computed, signal } from '@angular/core';
import Keycloak from 'keycloak-js';
import { API_BASE_URL, KEYCLOAK_CLIENT_ID, KEYCLOAK_REALM, KEYCLOAK_URL } from './api';

export type AuthRole = 'operator' | 'admin' | 'viewer';

const STORAGE_KEY = 'eku-oidc';

type StoredTokens = {
  access_token: string;
  refresh_token: string;
  id_token: string;
};

type AuthPayload = Partial<StoredTokens> & {
  message?: string | string[];
  requiresPasswordChange?: boolean;
};

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly keycloak = new Keycloak({
    url: KEYCLOAK_URL,
    realm: KEYCLOAK_REALM,
    clientId: KEYCLOAK_CLIENT_ID,
  });
  readonly ready = signal(false);
  readonly error = signal<string | null>(null);
  readonly authenticated = signal(false);
  readonly email = computed(() => this.profile()?.email ?? '');
  readonly name = computed(() => this.profile()?.name ?? this.email());
  readonly tenant = computed(() => this.profile()?.tenant ?? 'default');
  readonly role = computed(() => this.profile()?.role ?? 'viewer');
  readonly isOperator = computed(() => this.role() === 'operator');
  private readonly profile = signal<{
    email: string;
    name: string;
    tenant: string;
    role: AuthRole;
  } | null>(null);

  async init(): Promise<void> {
    try {
      const stored = this.readTokens();
      const ok = await this.keycloak.init({
        token: stored?.access_token,
        refreshToken: stored?.refresh_token,
        idToken: stored?.id_token,
        checkLoginIframe: false,
      });
      this.authenticated.set(!!ok && !!this.keycloak.token);
      this.syncProfile();
      this.persist();
    } catch {
      this.clear();
      this.error.set('No se pudo conectar con Keycloak. Ejecute npm run lab:iam.');
    } finally {
      this.ready.set(true);
    }
  }

  async signIn(email: string, password: string): Promise<'ok' | 'change-password'> {
    this.error.set(null);
    const response = await this.request(`${API_BASE_URL}/v1/auth/login`, { email, password });
    const payload = await this.readPayload(response);
    if (response.ok && payload.requiresPasswordChange) {
      return 'change-password';
    }
    if (!response.ok || !payload.access_token) {
      throw new Error(this.apiMessage(payload.message, 'Las credenciales no son válidas.'));
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return 'ok';
  }

  async completeFirstPassword(
    email: string,
    currentPassword: string,
    newPassword: string,
    confirmPassword: string,
  ): Promise<void> {
    this.error.set(null);
    const response = await this.request(`${API_BASE_URL}/v1/auth/first-password`, {
      email,
      currentPassword,
      newPassword,
      confirmPassword,
    });
    const payload = await this.readPayload(response);
    if (!response.ok || !payload.access_token) {
      throw new Error(this.apiMessage(payload.message, 'No fue posible actualizar la contraseña.'));
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  private async request(url: string, body: Record<string, string>): Promise<Response> {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('No se pudo conectar con el servidor. Compruebe que la API este en marcha.');
    }
  }

  private async readPayload(response: Response): Promise<AuthPayload> {
    try {
      return (await response.json()) as AuthPayload;
    } catch {
      return {};
    }
  }

  private apiMessage(message: string | string[] | undefined, fallback: string): string {
    if (Array.isArray(message)) {
      return message[0] || fallback;
    }
    return message || fallback;
  }

  logout(): void {
    this.clear();
    window.location.assign('/login');
  }

  token(): string {
    return this.keycloak.token ?? '';
  }

  async refresh(): Promise<string> {
    if (!this.authenticated()) {
      return '';
    }
    try {
      await this.keycloak.updateToken(30);
      this.syncProfile();
      this.persist();
    } catch {
      this.clear();
    }
    return this.token();
  }

  private persist(): void {
    if (!this.keycloak.token || !this.keycloak.refreshToken) {
      return;
    }
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        access_token: this.keycloak.token,
        refresh_token: this.keycloak.refreshToken,
        id_token: this.keycloak.idToken ?? '',
      }),
    );
  }

  private readTokens(): StoredTokens | null {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as StoredTokens) : null;
    } catch {
      return null;
    }
  }

  private clear(): void {
    sessionStorage.removeItem(STORAGE_KEY);
    this.authenticated.set(false);
    this.profile.set(null);
  }

  private syncProfile(): void {
    const parsed = this.keycloak.tokenParsed;
    if (!parsed) {
      this.profile.set(null);
      return;
    }
    const roles = parsed.realm_access?.roles ?? [];
    const role: AuthRole = roles.includes('operator')
      ? 'operator'
      : roles.includes('admin')
        ? 'admin'
        : 'viewer';
    const email = String(parsed['email'] ?? parsed['preferred_username'] ?? '');
    const name = [parsed['given_name'], parsed['family_name']].filter(Boolean).join(' ') || email;
    this.profile.set({
      email,
      name,
      tenant: String(parsed['tenant'] ?? 'default'),
      role,
    });
  }
}
