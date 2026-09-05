import { ConflictException } from '@nestjs/common';

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

export function isOptionalTenantModule(
  value: string,
): value is OptionalTenantModule {
  return VALID.has(value);
}

export function parseStoredModules(value: unknown): OptionalTenantModule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<OptionalTenantModule>();
  const modules: OptionalTenantModule[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const id = item.trim().toLowerCase();
    if (!isOptionalTenantModule(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    modules.push(id);
  }
  return modules;
}

export function normalizeTenantModules(input?: unknown): OptionalTenantModule[] {
  if (input == null) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new ConflictException(
      'modules debe ser una lista de identificadores.',
    );
  }
  const seen = new Set<OptionalTenantModule>();
  const modules: OptionalTenantModule[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') {
      throw new ConflictException('Cada modulo debe ser un identificador.');
    }
    const id = raw.trim().toLowerCase();
    if (!id) {
      continue;
    }
    if (!isOptionalTenantModule(id)) {
      throw new ConflictException(`Modulo no valido: ${id}.`);
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    modules.push(id);
  }
  return modules;
}

export function tenantHasModule(
  modules: unknown,
  id: OptionalTenantModule,
): boolean {
  return parseStoredModules(modules).includes(id);
}

export function dashboardViewModule(
  view?: string,
): OptionalTenantModule | null {
  const value = (view ?? '').trim().toLowerCase();
  return isOptionalTenantModule(value) ? value : null;
}

export function applyTenantModuleFilter<
  T extends {
    databases: unknown[];
    networkDevices: unknown[];
    queues: unknown[];
    icewarp: unknown[];
    sap: unknown[];
  },
>(payload: T, modules: unknown): T {
  const enabled = new Set(parseStoredModules(modules));
  return {
    ...payload,
    databases: enabled.has('databases') ? payload.databases : [],
    networkDevices: enabled.has('network') ? payload.networkDevices : [],
    queues: enabled.has('queues') ? payload.queues : [],
    icewarp: enabled.has('icewarp') ? payload.icewarp : [],
    sap: enabled.has('sap') ? payload.sap : [],
  };
}
