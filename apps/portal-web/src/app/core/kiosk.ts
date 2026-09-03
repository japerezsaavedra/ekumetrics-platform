import { HttpBackend, HttpClient } from '@angular/common/http';
import { Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from './api';

type StoredDevice = { deviceId: string; deviceSecret: string };
type KioskSession = {
  accessToken: string;
  expiresIn: number;
  deviceSecret: string;
  scope: { tenant: string; site: string; dashboard: string };
};

const STORAGE_KEY = 'eku-kiosk-device';

@Injectable({ providedIn: 'root' })
export class KioskService {
  readonly active = signal(false);
  readonly connected = signal(false);
  readonly scope = signal<KioskSession['scope'] | null>(null);
  private readonly http: HttpClient;
  private accessToken = '';
  private accessExpiresAt = 0;
  private renewPromise: Promise<string> | null = null;
  private renewTimer: number | null = null;
  private heartbeatTimer: number | null = null;

  constructor(backend: HttpBackend) {
    this.http = new HttpClient(backend);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.active()) this.exit();
    });
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && this.active()) this.exit();
      if (document.fullscreenElement) {
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      }
    });
  }

  hasEnrollment(): boolean {
    return this.readDevice() !== null;
  }

  async enroll(deviceId: string, deviceSecret: string): Promise<KioskSession['scope']> {
    this.writeDevice({ deviceId: deviceId.trim(), deviceSecret: deviceSecret.trim() });
    try {
      await this.renew(true);
      return this.scope()!;
    } catch (error) {
      this.clearEnrollment();
      throw error;
    }
  }

  async startSession(): Promise<KioskSession['scope'] | null> {
    if (!this.hasEnrollment()) return null;
    await this.renew();
    this.enter();
    return this.scope();
  }

  async token(): Promise<string> {
    if (!this.hasEnrollment()) return '';
    if (this.accessToken && Date.now() < this.accessExpiresAt - 120_000) return this.accessToken;
    return this.renew();
  }

  clearEnrollment(): void {
    localStorage.removeItem(STORAGE_KEY);
    this.accessToken = '';
    this.accessExpiresAt = 0;
    this.scope.set(null);
    this.connected.set(false);
    this.stopTimers();
    this.exit();
  }

  toggle(): void {
    this.active() ? this.exit() : this.enter();
  }

  enter(): void {
    this.active.set(true);
    document.documentElement.classList.add('eku-kiosk');
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  exit(): void {
    this.active.set(false);
    document.documentElement.classList.remove('eku-kiosk');
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }

  private renew(force = false): Promise<string> {
    if (!force && this.renewPromise) return this.renewPromise;
    const device = this.readDevice();
    if (!device) return Promise.resolve('');
    this.renewPromise = firstValueFrom(
      this.http.post<KioskSession>(`${API_BASE_URL}/v1/kiosk/session`, device),
    )
      .then((session) => {
        this.writeDevice({ deviceId: device.deviceId, deviceSecret: session.deviceSecret });
        this.accessToken = session.accessToken;
        this.accessExpiresAt = Date.now() + session.expiresIn * 1000;
        this.scope.set(session.scope);
        this.connected.set(true);
        this.scheduleRenewal(session.expiresIn);
        this.scheduleHeartbeat();
        return session.accessToken;
      })
      .catch((error) => {
        this.connected.set(false);
        throw error;
      })
      .finally(() => (this.renewPromise = null));
    return this.renewPromise;
  }

  private scheduleRenewal(expiresIn: number): void {
    if (this.renewTimer !== null) window.clearTimeout(this.renewTimer);
    this.renewTimer = window.setTimeout(
      () => void this.renew().catch(() => undefined),
      Math.max((expiresIn - 180) * 1000, 30_000),
    );
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    const send = async () => {
      try {
        const token = await this.token();
        if (token) {
          await firstValueFrom(
            this.http.post(
              `${API_BASE_URL}/v1/kiosk/heartbeat`,
              {},
              {
                headers: { Authorization: `Bearer ${token}` },
              },
            ),
          );
        }
      } catch {
        this.connected.set(false);
      }
    };
    this.heartbeatTimer = window.setInterval(() => void send(), 5 * 60 * 1000);
  }

  private stopTimers(): void {
    if (this.renewTimer !== null) window.clearTimeout(this.renewTimer);
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    this.renewTimer = null;
    this.heartbeatTimer = null;
  }

  private readDevice(): StoredDevice | null {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as StoredDevice | null;
      return value?.deviceId && value.deviceSecret ? value : null;
    } catch {
      return null;
    }
  }

  private writeDevice(value: StoredDevice): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  }
}
