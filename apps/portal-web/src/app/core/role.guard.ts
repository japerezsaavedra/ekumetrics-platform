import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthService, type AuthRole } from './auth';

export const roleGuard: CanActivateFn = (route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.authenticated()) {
    return router.createUrlTree(['/login'], { queryParams: { redirect: state.url } });
  }
  const roles = (route.data['roles'] ?? []) as AuthRole[];
  return roles.includes(auth.role()) ? true : router.createUrlTree(['/hosts']);
};
