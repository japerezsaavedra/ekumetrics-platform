import { buildAgentYaml } from './agent-yaml';

describe('buildAgentYaml', () => {
  const base = {
    tenantId: 'acme',
    site: 'local',
    agentId: 'EKM-01',
    mode: 'site',
  };

  it('no propone IceWarp ni SAP si el tenant no los tiene', () => {
    const yaml = buildAgentYaml(base);
    expect(yaml).not.toContain('\nicewarp:');
    expect(yaml).not.toContain('\nsap:');
    expect(yaml).not.toContain('\ndatabases:');
    expect(yaml).not.toContain('\nqueues:');
    expect(yaml).not.toContain('\nsnmp:');
    expect(yaml).toContain('tenantId: acme');
  });

  it('incluye solo los bloques de los modulos activos', () => {
    const yaml = buildAgentYaml({ ...base, modules: ['icewarp', 'sap'] });
    expect(yaml).toContain('\nicewarp:');
    expect(yaml).toContain('\nsap:');
    expect(yaml).not.toContain('\ndatabases:');
    expect(yaml).not.toContain('\nsnmp:');
  });
});
