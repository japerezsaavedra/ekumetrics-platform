import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { AdminSitesPage } from './pages/admin/admin-sites-page';
import { AdminUsersPage } from './pages/admin/admin-users-page';
import { AgentPage } from './pages/agent/agent-page';
import { HolmesPage } from './pages/holmes/holmes-page';
import { HomePage } from './pages/home/home-page';
import { LoginPage } from './pages/login/login-page';
import { SettingsPage } from './pages/settings/settings-page';
import { TenantsPage } from './pages/tenants/tenants-page';

const guarded = { canActivate: [authGuard] };

export const routes: Routes = [
  { path: 'login', component: LoginPage },
  { path: '', redirectTo: 'hosts', pathMatch: 'full' },
  { path: 'hosts', component: HomePage, ...guarded },
  { path: 'hosts/:hostId', component: HomePage, ...guarded },
  { path: 'red', component: HomePage, ...guarded },
  { path: 'agentes', component: HomePage, ...guarded },
  { path: 'agentes/:agentId', component: HomePage, ...guarded },
  { path: 'bases-de-datos', component: HomePage, ...guarded },
  { path: 'colas', component: HomePage, ...guarded },
  { path: 'icewarp', component: HomePage, ...guarded },
  { path: 'sap', component: HomePage, ...guarded },
  { path: 'logs', redirectTo: 'hosts', pathMatch: 'full' },
  { path: 'asistente', component: HolmesPage, ...guarded },
  { path: 'holmes', redirectTo: 'asistente', pathMatch: 'full' },
  { path: 'administracion', redirectTo: 'administracion/sitios', pathMatch: 'full' },
  { path: 'administracion/tenants', component: TenantsPage, ...guarded },
  { path: 'administracion/usuarios', component: AdminUsersPage, ...guarded },
  { path: 'administracion/sitios', component: AdminSitesPage, ...guarded },
  { path: 'configuracion', component: SettingsPage, ...guarded },
  { path: 'configuracion/tenants', redirectTo: 'administracion/tenants', pathMatch: 'full' },
  { path: 'configuracion/agente', component: AgentPage, ...guarded },
  { path: 'agente', redirectTo: 'configuracion/agente', pathMatch: 'full' },
];
