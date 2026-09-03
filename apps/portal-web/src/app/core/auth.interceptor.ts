import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap } from 'rxjs';
import { API_BASE_URL } from './api';
import { AuthService } from './auth';
import { KioskService } from './kiosk';
import { TenantService } from './tenant';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(API_BASE_URL)) return next(req);
  const auth = inject(AuthService);
  const tenants = inject(TenantService);
  const kiosk = inject(KioskService);
  if (!auth.authenticated()) {
    if (!kiosk.hasEnrollment() || req.url.endsWith('/v1/kiosk/session')) {
      return next(req.clone({ withCredentials: true }));
    }
    return from(kiosk.token()).pipe(
      switchMap((token) =>
        next(token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req),
      ),
    );
  }
  const headers: Record<string, string> = {};
  if (!SAFE_METHODS.has(req.method.toUpperCase()) && auth.csrfToken()) {
    headers['X-CSRF-Token'] = auth.csrfToken();
  }
  if (auth.isOperator()) headers['X-Eku-Tenant'] = tenants.slug();
  return next(req.clone({ withCredentials: true, setHeaders: headers }));
};
