import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { API_BASE_URL } from './api';
import { KioskService } from './kiosk';

describe('KioskService device session', () => {
  let service: KioskService;
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(KioskService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    service.clearEnrollment();
    http.verify();
    vi.useRealTimers();
  });

  it('activa una identidad no personal y conserva su alcance', async () => {
    const activation = service.enroll('device-1', 'initial-secret');
    const request = http.expectOne(`${API_BASE_URL}/v1/kiosk/session`);
    expect(request.request.body).toEqual({
      deviceId: 'device-1',
      deviceSecret: 'initial-secret',
    });
    request.flush({
      accessToken: 'short-access-token',
      expiresIn: 600,
      deviceSecret: 'initial-secret',
      scope: { tenant: 'acme', site: 'north', dashboard: 'hosts' },
    });

    await expect(activation).resolves.toEqual({
      tenant: 'acme',
      site: 'north',
      dashboard: 'hosts',
    });
    await expect(service.token()).resolves.toBe('short-access-token');
    expect(service.connected()).toBe(true);
  });

  it('elimina la identidad local cuando la activación es rechazada', async () => {
    const activation = service.enroll('device-1', 'revoked-secret');
    http
      .expectOne(`${API_BASE_URL}/v1/kiosk/session`)
      .flush({ message: 'revoked' }, { status: 401, statusText: 'Unauthorized' });

    await expect(activation).rejects.toBeTruthy();
    expect(service.hasEnrollment()).toBe(false);
  });
});
