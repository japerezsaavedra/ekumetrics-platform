import { TestBed } from '@angular/core/testing';
import type { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { Router } from '@angular/router';
import { AuthService } from './auth';
import { roleGuard } from './role.guard';

describe('roleGuard', () => {
  function evaluate(role: 'operator' | 'admin' | 'viewer') {
    const redirect = { redirect: '/hosts' };
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AuthService,
          useValue: {
            authenticated: () => true,
            role: () => role,
          },
        },
        {
          provide: Router,
          useValue: { createUrlTree: () => redirect },
        },
      ],
    });
    const route = {
      data: { roles: ['operator', 'admin'] },
    } as unknown as ActivatedRouteSnapshot;
    const state = { url: '/administracion/sitios' } as RouterStateSnapshot;
    return { result: TestBed.runInInjectionContext(() => roleGuard(route, state)), redirect };
  }

  it('permite un rol autorizado', () => {
    expect(evaluate('admin').result).toBe(true);
  });

  it('redirige a un viewer fuera de administración', () => {
    const { result, redirect } = evaluate('viewer');
    expect(result).toBe(redirect);
  });
});
