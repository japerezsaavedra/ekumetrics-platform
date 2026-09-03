import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { KioskService } from './kiosk';

const ROUTE_BY_DASHBOARD: Record<string, string> = {
  hosts: 'hosts',
  network: 'red',
  databases: 'bases-de-datos',
  queues: 'colas',
  icewarp: 'icewarp',
  sap: 'sap',
};

export const kioskGuard: CanActivateFn = async (route) => {
  const kiosk = inject(KioskService);
  const router = inject(Router);
  try {
    const scope = await kiosk.startSession();
    if (!scope) return router.createUrlTree(['/kiosk/activar']);
    if (scope.dashboard.startsWith('custom:')) {
      const boardId = scope.dashboard.slice('custom:'.length);
      return route.paramMap.get('id') === boardId
        ? true
        : router.createUrlTree(['/kiosk/board', boardId]);
    }
    const assignedRoute = ROUTE_BY_DASHBOARD[scope.dashboard] ?? 'hosts';
    return route.paramMap.get('dashboard') === assignedRoute
      ? true
      : router.createUrlTree(['/kiosk', assignedRoute]);
  } catch {
    kiosk.clearEnrollment();
    return router.createUrlTree(['/kiosk/activar'], { queryParams: { invalid: 1 } });
  }
};
