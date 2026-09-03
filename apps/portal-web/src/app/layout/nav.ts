import type { AuthRole } from '../core/auth';

export type NavChild = {
  label: string;
  path: string;
  operatorOnly?: boolean;
  roles?: AuthRole[];
};

export type NavItem = {
  id: string;
  label: string;
  icon: string;
  path?: string;
  children?: NavChild[];
  operatorOnly?: boolean;
  roles?: AuthRole[];
};

export const NAV_ITEMS: NavItem[] = [
  { id: 'asistente', label: 'EkuAssistant AI', icon: 'smart_toy', path: '/asistente' },
  { id: 'hosts', label: 'Hosts', icon: 'dns', path: '/hosts' },
  { id: 'red', label: 'Red', icon: 'lan', path: '/red' },
  { id: 'agentes', label: 'Agentes', icon: 'memory', path: '/agentes' },
  { id: 'databases', label: 'Bases de datos', icon: 'storage', path: '/bases-de-datos' },
  { id: 'queues', label: 'Colas', icon: 'account_tree', path: '/colas' },
  { id: 'icewarp', label: 'IceWarp', icon: 'mail', path: '/icewarp' },
  { id: 'sap', label: 'SAP', icon: 'lan', path: '/sap' },
  { id: 'dashboards', label: 'Dashboards', icon: 'dashboard_customize', path: '/dashboards' },
  {
    id: 'alerts',
    label: 'Alertas',
    icon: 'notifications_active',
    roles: ['operator', 'admin'],
    children: [
      { label: 'Activas', path: '/alertas', roles: ['operator', 'admin'] },
      { label: 'Incidentes', path: '/incidentes', roles: ['operator', 'admin'] },
      { label: 'Canales', path: '/alertas/canales', roles: ['operator', 'admin'] },
    ],
  },
  {
    id: 'plataforma',
    label: 'E-Platform',
    icon: 'monitor_heart',
    path: '/plataforma',
    roles: ['operator', 'admin'],
  },
  {
    id: 'admin',
    label: 'Administracion',
    icon: 'admin_panel_settings',
    roles: ['operator', 'admin'],
    children: [
      { label: 'Tenants', path: '/administracion/tenants', roles: ['operator'] },
      { label: 'Usuarios', path: '/administracion/usuarios', roles: ['operator', 'admin'] },
      { label: 'Sitios', path: '/administracion/sitios', roles: ['operator', 'admin'] },
      { label: 'Identidad', path: '/administracion/identidad', roles: ['operator', 'admin'] },
      { label: 'Umbrales', path: '/administracion/umbrales', roles: ['operator', 'admin'] },
      { label: 'Modelos de IA', path: '/administracion/ia', roles: ['operator', 'admin'] },
      { label: 'Descargar agente', path: '/administracion/agente', roles: ['operator', 'admin'] },
    ],
  },
];

export function navGroupOpenByDefault(path: string): Record<string, boolean> {
  return {
    admin: path.startsWith('/administracion'),
    alerts: path.startsWith('/alertas') || path.startsWith('/incidentes'),
  };
}
