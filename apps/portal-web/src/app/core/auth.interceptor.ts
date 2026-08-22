import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap } from 'rxjs';
import { AuthService } from './auth';
import { TenantService } from './tenant';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const tenants = inject(TenantService);
  if (!auth.authenticated()) {
    return next(req);
  }
  return from(auth.refresh()).pipe(
    switchMap((token) => {
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      if (auth.isOperator()) {
        headers['X-Eku-Tenant'] = tenants.slug();
      }
      return next(Object.keys(headers).length ? req.clone({ setHeaders: headers }) : req);
    }),
  );
};
