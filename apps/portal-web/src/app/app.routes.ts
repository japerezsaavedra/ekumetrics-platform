import { Routes, UrlSegment } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { AdminIdentityPage } from './pages/admin/admin-identity-page';
import { AdminSitesPage } from './pages/admin/admin-sites-page';
import { AdminThresholdsPage } from './pages/admin/admin-thresholds-page';
import { AdminUsersPage } from './pages/admin/admin-users-page';
import { AgentPage } from './pages/agent/agent-page';
import { AlertChannelsPage } from './pages/alerts/alert-channels-page';
import { AlertsPage } from './pages/alerts/alerts-page';
import { IncidentsPage } from './pages/incidents/incidents-page';
import { HolmesPage } from './pages/holmes/holmes-page';
import { HomePage } from './pages/home/home-page';
import { LoginPage } from './pages/login/login-page';
import { MfaEnrollPage } from './pages/login/mfa-enroll-page';
import { BoardEditorPage } from './pages/boards/board-editor-page';
import { BoardViewPage } from './pages/boards/board-view-page';
import { BoardsPage } from './pages/boards/boards-page';
import { PlataformaPage } from './pages/plataforma/plataforma-page';
import { SettingsPage } from './pages/settings/settings-page';
import { TenantsPage } from './pages/tenants/tenants-page';
import { KioskActivationPage } from './pages/kiosk/kiosk-activation-page';
import { kioskGuard } from './core/kiosk.guard';
import { roleGuard } from './core/role.guard';

const guarded = { canActivate: [authGuard] };

const DASHBOARD_ROOTS = new Set([
  'hosts',
  'red',
  'agentes',
  'bases-de-datos',
  'colas',
  'icewarp',
  'sap',
]);

function dashboardMatcher(segments: UrlSegment[]) {
  const root = segments[0]?.path;
  if (!root || !DASHBOARD_ROOTS.has(root)) {
    return null;
  }
  return { consumed: segments };
}

export const routes: Routes = [
  { path: 'login', component: LoginPage },
  { path: 'enrolar-mfa', component: MfaEnrollPage, canActivate: [authGuard] },
  { path: 'kiosk/activar', component: KioskActivationPage },
  { path: 'kiosk/board/:id', component: BoardViewPage, canActivate: [kioskGuard] },
  { path: 'kiosk/:dashboard', component: HomePage, canActivate: [kioskGuard] },
  { path: '', redirectTo: 'hosts', pathMatch: 'full' },
  { matcher: dashboardMatcher, component: HomePage, ...guarded },
  { path: 'logs', redirectTo: 'hosts', pathMatch: 'full' },
  { path: 'asistente', component: HolmesPage, ...guarded },
  { path: 'dashboards', component: BoardsPage, ...guarded },
  {
    path: 'dashboards/:id',
    component: BoardEditorPage,
    canActivate: [authGuard, roleGuard],
    data: { roles: ['operator', 'admin'] },
  },
  { path: 'dashboards/:id/ver', component: BoardViewPage, ...guarded },
  {
    path: 'plataforma',
    component: PlataformaPage,
    canActivate: [authGuard, roleGuard],
    data: { roles: ['operator', 'admin'] },
  },
  {
    path: 'alertas',
    component: AlertsPage,
    canActivate: [authGuard, roleGuard],
    data: { roles: ['operator', 'admin'] },
  },
  {
    path: 'incidentes',
    component: IncidentsPage,
    canActivate: [authGuard, roleGuard],
    data: { roles: ['operator', 'admin'] },
  },
  {
    path: 'alertas/canales',
    component: AlertChannelsPage,
    canActivate: [authGuard, roleGuard],
    data: { roles: ['operator', 'admin'] },
  },
  { path: 'holmes', redirectTo: 'asistente', pathMatch: 'full' },
  { path: 'administracion', redirectTo: 'administracion/sitios', pathMatch: 'full' },
  {
    path: 'administracion/tenants',
    component: TenantsPage,
    canActivate: [authGuard, roleGuard],
    data: { roles: ['operator'] },
  },
  {
    path: 'administracion/usuarios',
    component: AdminUsersPage,
    canActivate: [authGuard, roleGuard],
    data: { roles: ['operator', 'admin'] },
  },
  {
    path: 'administracion/sitios',
    component: AdminSitesPage,
    canActivate: [authGuard, roleGuard],
    data: { roles: ['operator', 'admin'] },
  },
  {
    path: 'administracion/identidad',
    component: AdminIdentityPage,
    canActivate: [authGuard, roleGuard],
    data: { roles: ['operator', 'admin'] },
  },
  {
    path: 'administracion/umbrales',
    component: AdminThresholdsPage,
    canActivate: [authGuard, roleGuard],
    data: { roles: ['operator', 'admin'] },
  },
  {
    path: 'administracion/umbrales/:scope',
    component: AdminThresholdsPage,
    canActivate: [authGuard, roleGuard],
    data: { roles: ['operator', 'admin'] },
  },
  {
    path: 'administracion/ia',
    component: SettingsPage,
    canActivate: [authGuard, roleGuard],
    data: { roles: ['operator', 'admin'] },
  },
  {
    path: 'administracion/agente',
    component: AgentPage,
    canActivate: [authGuard, roleGuard],
    data: { roles: ['operator', 'admin'] },
  },
  { path: 'configuracion', redirectTo: 'administracion/ia', pathMatch: 'full' },
  { path: 'configuracion/tenants', redirectTo: 'administracion/tenants', pathMatch: 'full' },
  { path: 'configuracion/agente', redirectTo: 'administracion/agente', pathMatch: 'full' },
  { path: 'agente', redirectTo: 'administracion/agente', pathMatch: 'full' },
];
