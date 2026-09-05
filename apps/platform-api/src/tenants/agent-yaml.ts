import { parseStoredModules, type OptionalTenantModule } from './tenant-modules';

const CORE = `# Ekumetrics Agent — un proceso, un YAML.
# Active solo lo que vaya a recolectar. Guía: docs/USO.md  Rol: docs/ROL.md

agent:
  environment: production
  site: __SITE__
  tenantId: __TENANT__
  agentId: "__AGENT_ID__"
  mode: __MODE__
  metricsAddr: ":9090"
  license: ""
  interval: 5s

export:
  otlp:
    endpoint: ""
    insecure: true
    caFile: ""
    certFile: ""
    keyFile: ""
    serverName: ""
  buffer:
    dir: ""
    maxItems: 10000
    maxBytes: 20971520
    compress: false

receive:
  otlp:
    grpc: ":4317"
    http: ":4318"

modules:
  metrics:
    host:
      enabled: true
    processes:
      enabled: false
      names: []
    scrape:
      enabled: false
      jobs: []
    otlp:
      enabled: false
  logs:
    enabled: false
    files: []
    journald: false
    windowsEvent: false
    otlp: false
  traces:
    enabled: false
  ingest:
    syslog:
      enabled: false
      listen: ":5514"
      protocol: udp
      rfc: rfc3164
    netflow:
      enabled: false
      listen: ":2055"
    traps:
      enabled: false
      listen: ":9162"
  discovery:
    passive:
      enabled: false
  probes:
    enabled: false
    interval: 5s
    targets: []
`;

const OPTIONAL_BLOCKS: Record<OptionalTenantModule, string> = {
  network: `
snmp:
  enabled: false
  devices: []
`,
  databases: `
databases:
  enabled: false
  targets: []
`,
  queues: `
queues:
  enabled: false
  targets: []
`,
  icewarp: `
icewarp:
  enabled: false
  targets: []
`,
  sap: `
sap:
  enabled: false
  targets: []
`,
};

export function buildAgentYaml(input: {
  tenantId: string;
  site: string;
  agentId: string;
  mode: string;
  modules?: unknown;
}): string {
  const enabled = parseStoredModules(input.modules);
  const extras = enabled
    .map((id) => OPTIONAL_BLOCKS[id].trimEnd())
    .filter(Boolean)
    .join('\n');
  const yaml = extras ? `${CORE.trimEnd()}\n${extras}\n` : `${CORE.trimEnd()}\n`;
  return yaml
    .replaceAll('__SITE__', input.site)
    .replaceAll('__TENANT__', input.tenantId)
    .replaceAll('__AGENT_ID__', input.agentId)
    .replaceAll('__MODE__', input.mode);
}
