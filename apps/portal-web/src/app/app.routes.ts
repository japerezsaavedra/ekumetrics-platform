import { Routes } from '@angular/router';
import { AdminSitesPage } from './pages/admin/admin-sites-page';
import { AdminUsersPage } from './pages/admin/admin-users-page';
import { AgentPage } from './pages/agent/agent-page';
import { HolmesPage } from './pages/holmes/holmes-page';
import { HomePage } from './pages/home/home-page';
import { SettingsPage } from './pages/settings/settings-page';
import { TenantsPage } from './pages/tenants/tenants-page';

export const routes: Routes = [
  { path: '', redirectTo: 'hosts', pathMatch: 'full' },
  { path: 'hosts', component: HomePage },
  { path: 'hosts/:hostId', component: HomePage },
  { path: 'red', component: HomePage },
  { path: 'agentes', component: HomePage },
  { path: 'agentes/:agentId', component: HomePage },
  { path: 'bases-de-datos', component: HomePage },
  { path: 'colas', component: HomePage },
  { path: 'icewarp', component: HomePage },
  { path: 'sap', component: HomePage },
  { path: 'logs', redirectTo: 'hosts', pathMatch: 'full' },
  { path: 'asistente', component: HolmesPage },
  { path: 'holmes', redirectTo: 'asistente', pathMatch: 'full' },
  { path: 'administracion', redirectTo: 'administracion/sitios', pathMatch: 'full' },
  { path: 'administracion/tenants', component: TenantsPage },
  { path: 'administracion/usuarios', component: AdminUsersPage },
  { path: 'administracion/sitios', component: AdminSitesPage },
  { path: 'configuracion', component: SettingsPage },
  { path: 'configuracion/tenants', redirectTo: 'administracion/tenants', pathMatch: 'full' },
  { path: 'configuracion/agente', component: AgentPage },
  { path: 'agente', redirectTo: 'configuracion/agente', pathMatch: 'full' },
];
