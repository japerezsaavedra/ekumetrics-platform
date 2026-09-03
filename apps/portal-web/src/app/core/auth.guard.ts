import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth';

export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.authenticated()) {
    return router.createUrlTree(['/login'], { queryParams: { redirect: state.url } });
  }
  if (auth.mfaEnrollmentRequired() && !state.url.startsWith('/enrolar-mfa')) {
    return router.createUrlTree(['/enrolar-mfa'], { queryParams: { redirect: state.url } });
  }
  return true;
};
