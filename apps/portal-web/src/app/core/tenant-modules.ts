export const OPTIONAL_TENANT_MODULES = [
  'icewarp',
  'sap',
  'databases',
  'queues',
  'network',
] as const;

export type OptionalTenantModule = (typeof OPTIONAL_TENANT_MODULES)[number];

export const TENANT_MODULE_CATALOG: ReadonlyArray<{
  id: OptionalTenantModule;
  label: string;
}> = [
  { id: 'icewarp', label: 'IceWarp' },
  { id: 'sap', label: 'SAP' },
  { id: 'databases', label: 'Bases de datos' },
  { id: 'queues', label: 'Colas' },
  { id: 'network', label: 'Red' },
];

const VALID = new Set<string>(OPTIONAL_TENANT_MODULES);

export function parseTenantModules(value: unknown): OptionalTenantModule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is OptionalTenantModule =>
      typeof item === 'string' && VALID.has(item),
  );
}

export function tenantHasModule(modules: unknown, id: OptionalTenantModule): boolean {
  return parseTenantModules(modules).includes(id);
}
