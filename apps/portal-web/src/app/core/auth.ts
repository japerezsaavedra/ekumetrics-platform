import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from './api';

export type AuthRole = 'operator' | 'admin' | 'viewer';

const KEEP_ALIVE_INTERVAL_MS = 60_000;

type SessionResponse = {
  user: { email: string; name: string; tenant: string; role: AuthRole };
  csrfToken: string;
  mfaEnrollmentRequired?: boolean;
  redirect?: string;
};

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  readonly ready = signal(false);
  readonly error = signal<string | null>(null);
  readonly authenticated = signal(false);
  readonly email = computed(() => this.profile()?.email ?? '');
  readonly name = computed(() => this.profile()?.name ?? this.email());
  readonly tenant = computed(() => this.profile()?.tenant ?? 'default');
  readonly role = computed(() => this.profile()?.role ?? 'viewer');
  readonly isOperator = computed(() => this.role() === 'operator');
  readonly mfaEnrollmentRequired = signal(false);
  private keepAliveTimer: number | null = null;
  private csrf = '';
  private refreshInFlight: Promise<void> | null = null;
  private lifecycleListenersRegistered = false;
  private readonly profile = signal<SessionResponse['user'] | null>(null);

  async init(): Promise<void> {
    this.registerLifecycleListeners();
    try {
      await this.loadSession();
    } catch (error) {
      this.clear();
      if (!(error instanceof HttpErrorResponse) || error.status !== 401) {
        this.error.set('No se pudo consultar la sesión segura.');
      }
    } finally {
      this.ready.set(true);
    }
  }

  async loginOptions(email: string): Promise<{
    mfaRequired: boolean;
    totpEnrolled: boolean;
    entraEnabled: boolean;
    adEnabled: boolean;
    idpHint: string;
  }> {
    return firstValueFrom(
      this.http.get<{
        mfaRequired: boolean;
        totpEnrolled: boolean;
        entraEnabled: boolean;
        adEnabled: boolean;
        idpHint: string;
      }>(`${API_BASE_URL}/v1/auth/login-options`, { params: { email } }),
    );
  }

  beginBroker(email: string, redirect = '/hosts'): void {
    const path = this.safeApplicationPath(redirect);
    this.navigate(
      `${API_BASE_URL}/v1/auth/broker?email=${encodeURIComponent(email)}&redirect=${encodeURIComponent(path)}`,
    );
  }

  async beginLogin(
    email: string,
    password: string,
    redirect = '/hosts',
    totp = '',
  ): Promise<string> {
    this.error.set(null);
    const path = this.safeApplicationPath(redirect);
    try {
      const session = await firstValueFrom(
        this.http.post<SessionResponse>(
          `${API_BASE_URL}/v1/auth/login`,
          { email, password, totp, redirect: path },
          { withCredentials: true },
        ),
      );
      this.applySession(session);
      return session.mfaEnrollmentRequired ? '/enrolar-mfa' : path;
    } catch (error) {
      this.clear();
      if (error instanceof HttpErrorResponse) {
        const message = error.error?.message;
        throw new Error(typeof message === 'string' ? message : 'No fue posible iniciar sesión.');
      }
      throw error;
    }
  }

  async logout(): Promise<void> {
    this.stopKeepAlive();
    try {
      const result = await firstValueFrom(
        this.http.post<{ logoutUrl: string }>(
          `${API_BASE_URL}/v1/auth/logout`,
          {},
          {
            withCredentials: true,
            headers: { 'X-CSRF-Token': this.csrf },
          },
        ),
      );
      this.clear();
      this.navigate(result.logoutUrl);
    } catch {
      this.clear();
      this.navigate('/login');
    }
  }

  csrfToken(): string {
    return this.csrf;
  }

  async refresh(): Promise<void> {
    if (!this.authenticated() || this.refreshInFlight) return this.refreshInFlight ?? undefined;
    this.refreshInFlight = this.loadSession()
      .catch((error) => {
        if (error instanceof HttpErrorResponse && error.status === 401) this.clear();
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
    return this.refreshInFlight;
  }

  private async loadSession(): Promise<void> {
    const session = await firstValueFrom(
      this.http.get<SessionResponse>(`${API_BASE_URL}/v1/auth/session`, {
        withCredentials: true,
      }),
    );
    this.applySession(session);
    this.error.set(null);
  }

  async beginMfaSetup(): Promise<{ qrDataUrl: string; secret: string }> {
    return firstValueFrom(
      this.http.post<{ qrDataUrl: string; secret: string }>(
        `${API_BASE_URL}/v1/auth/mfa/setup`,
        {},
        { withCredentials: true },
      ),
    );
  }

  async confirmMfa(totp: string): Promise<void> {
    await firstValueFrom(
      this.http.post(
        `${API_BASE_URL}/v1/auth/mfa/confirm`,
        { totp },
        { withCredentials: true },
      ),
    );
    this.mfaEnrollmentRequired.set(false);
  }

  private safeApplicationPath(value: string): string {
    return value.startsWith('/') && !value.startsWith('//') ? value : '/hosts';
  }

  private navigate(url: string): void {
    window.location.assign(url);
  }

  private clear(): void {
    this.stopKeepAlive();
    this.csrf = '';
    this.authenticated.set(false);
    this.mfaEnrollmentRequired.set(false);
    this.profile.set(null);
  }

  private applySession(session: SessionResponse): void {
    this.profile.set(session.user);
    this.csrf = session.csrfToken;
    this.mfaEnrollmentRequired.set(session.mfaEnrollmentRequired === true);
    this.authenticated.set(true);
    this.startKeepAlive();
  }

  private registerLifecycleListeners(): void {
    if (this.lifecycleListenersRegistered) return;
    window.addEventListener('online', this.resumeKeepAlive);
    document.addEventListener('visibilitychange', this.resumeKeepAlive);
    this.lifecycleListenersRegistered = true;
  }

  private readonly resumeKeepAlive = (): void => {
    if (this.authenticated() && (document.visibilityState === 'visible' || navigator.onLine)) {
      void this.refresh();
    }
  };

  private startKeepAlive(): void {
    this.stopKeepAlive();
    if (this.authenticated()) {
      this.keepAliveTimer = window.setInterval(() => void this.refresh(), KEEP_ALIVE_INTERVAL_MS);
    }
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer === null) return;
    window.clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }
}
