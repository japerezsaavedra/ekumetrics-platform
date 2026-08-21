export type NavChild = {
  label: string;
  path: string;
  operatorOnly?: boolean;
};

export type NavItem = {
  id: string;
  label: string;
  icon: string;
  path?: string;
  children?: NavChild[];
  operatorOnly?: boolean;
};

export const NAV_ITEMS: NavItem[] = [
  { id: 'hosts', label: 'Hosts', icon: 'dns', path: '/hosts' },
  { id: 'red', label: 'Red', icon: 'lan', path: '/red' },
  { id: 'agentes', label: 'Agentes', icon: 'memory', path: '/agentes' },
  { id: 'databases', label: 'Bases de datos', icon: 'storage', path: '/bases-de-datos' },
  { id: 'queues', label: 'Colas', icon: 'account_tree', path: '/colas' },
  { id: 'icewarp', label: 'IceWarp', icon: 'mail', path: '/icewarp' },
  { id: 'sap', label: 'SAP', icon: 'lan', path: '/sap' },
  {
    id: 'admin',
    label: 'Administracion',
    icon: 'admin_panel_settings',
    children: [
      { label: 'Tenants', path: '/administracion/tenants', operatorOnly: true },
      { label: 'Usuarios', path: '/administracion/usuarios' },
      { label: 'Sitios', path: '/administracion/sitios' },
    ],
  },
  { id: 'asistente', label: 'EkuAssistant AI', icon: 'smart_toy', path: '/asistente' },
];

export function navGroupOpenByDefault(path: string): Record<string, boolean> {
  return {
    admin: path.startsWith('/administracion'),
  };
}
