import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AuthService } from './auth';

const SESSION = {
  user: {
    email: 'operator@gradotech.com',
    name: 'Operador Gradotech',
    tenant: 'default',
    role: 'operator' as const,
  },
  csrfToken: 'csrf-token',
};

describe('AuthService BFF session', () => {
  let service: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('restores identity through an HttpOnly BFF session without browser tokens', async () => {
    const initialization = service.init();
    const request = http.expectOne('http://localhost:3000/v1/auth/session');
    expect(request.request.withCredentials).toBe(true);
    request.flush(SESSION);
    await initialization;

    expect(service.authenticated()).toBe(true);
    expect(service.email()).toBe(SESSION.user.email);
    expect(service.csrfToken()).toBe('csrf-token');
    expect(sessionStorage.length).toBe(0);
  });

  it('renews the server session every minute without dashboard traffic', async () => {
    const initialization = service.init();
    http.expectOne('http://localhost:3000/v1/auth/session').flush(SESSION);
    await initialization;

    await vi.advanceTimersByTimeAsync(60_000);
    http.expectOne('http://localhost:3000/v1/auth/session').flush(SESSION);
    await vi.advanceTimersByTimeAsync(0);

    expect(service.authenticated()).toBe(true);
  });

  it('posts credentials to the BFF and keeps a relative destination', async () => {
    const login = service.beginLogin(
      'operator@gradotech.com',
      'secret',
      '/administracion/usuarios',
    );
    const request = http.expectOne('http://localhost:3000/v1/auth/login');
    expect(request.request.method).toBe('POST');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.body).toEqual({
      email: 'operator@gradotech.com',
      password: 'secret',
      totp: '',
      redirect: '/administracion/usuarios',
    });
    request.flush({ ...SESSION, redirect: '/administracion/usuarios' });

    await expect(login).resolves.toBe('/administracion/usuarios');
    expect(service.authenticated()).toBe(true);
    expect(service.csrfToken()).toBe('csrf-token');
  });

  it('rejects an external-looking post-login destination', async () => {
    const login = service.beginLogin(
      'operator@gradotech.com',
      'secret',
      '//malicious.example/path',
    );
    const request = http.expectOne('http://localhost:3000/v1/auth/login');
    expect(request.request.body).toEqual({
      email: 'operator@gradotech.com',
      password: 'secret',
      totp: '',
      redirect: '/hosts',
    });
    request.flush({ ...SESSION, redirect: '/hosts' });

    await expect(login).resolves.toBe('/hosts');
  });

  it('sends CSRF on logout and then closes the Keycloak session', async () => {
    const initialization = service.init();
    http.expectOne('http://localhost:3000/v1/auth/session').flush(SESSION);
    await initialization;
    const navigate = vi
      .spyOn(service as unknown as { navigate(url: string): void }, 'navigate')
      .mockImplementation(() => undefined);

    const logout = service.logout();
    const request = http.expectOne('http://localhost:3000/v1/auth/logout');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.headers.get('X-CSRF-Token')).toBe('csrf-token');
    request.flush({ logoutUrl: 'https://identity.example/logout' });
    await logout;

    expect(service.authenticated()).toBe(false);
    expect(navigate).toHaveBeenCalledWith('https://identity.example/logout');
  });
});
