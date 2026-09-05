import { ConflictException } from '@nestjs/common';
import {
  applyTenantModuleFilter,
  dashboardViewModule,
  normalizeTenantModules,
  parseStoredModules,
  tenantHasModule,
} from './tenant-modules';

describe('tenant-modules', () => {
  it('acepta el catalogo cerrado y elimina duplicados', () => {
    expect(normalizeTenantModules(['sap', 'ICEWARP', 'sap'])).toEqual([
      'sap',
      'icewarp',
    ]);
  });

  it('trata ausente o vacio como solo nucleo', () => {
    expect(normalizeTenantModules()).toEqual([]);
    expect(normalizeTenantModules([])).toEqual([]);
  });

  it('rechaza un identificador que no esta en el catalogo', () => {
    expect(() => normalizeTenantModules(['hosts'])).toThrow(ConflictException);
    expect(() => normalizeTenantModules(['icewarp', 'otro'])).toThrow(
      ConflictException,
    );
  });

  it('rechaza un cuerpo que no es lista', () => {
    expect(() => normalizeTenantModules('sap')).toThrow(ConflictException);
  });

  it('parsea lo persistido sin lanzar', () => {
    expect(parseStoredModules(['sap', 'hosts', 1, 'icewarp'])).toEqual([
      'sap',
      'icewarp',
    ]);
    expect(parseStoredModules(null)).toEqual([]);
  });

  it('filtra inventarios de familias no contratadas', () => {
    const filtered = applyTenantModuleFilter(
      {
        databases: [{ id: 'db' }],
        networkDevices: [{ id: 'sw' }],
        queues: [{ id: 'q' }],
        icewarp: [{ id: 'mail' }],
        sap: [{ id: 'sap' }],
      },
      ['databases'],
    );
    expect(filtered.databases).toHaveLength(1);
    expect(filtered.networkDevices).toEqual([]);
    expect(filtered.queues).toEqual([]);
    expect(filtered.icewarp).toEqual([]);
    expect(filtered.sap).toEqual([]);
  });

  it('mapea la vista del dashboard al modulo opcional', () => {
    expect(dashboardViewModule('icewarp')).toBe('icewarp');
    expect(dashboardViewModule('hosts')).toBeNull();
    expect(tenantHasModule(['network'], 'network')).toBe(true);
    expect(tenantHasModule([], 'network')).toBe(false);
  });
});
