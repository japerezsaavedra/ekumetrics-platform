import type { GraphLink } from './graph-walk';

export const GRAPH_EXAMPLE_NODES: Array<{
  key: string;
  name: string;
  kind: string;
}> = [
  { key: 'sw-core', name: 'Core switch', kind: 'switch' },
  { key: 'app-01', name: 'App 01', kind: 'host' },
  { key: 'app-02', name: 'App 02', kind: 'host' },
  { key: 'db-01', name: 'DB 01', kind: 'host' },
  { key: 'api-pagos', name: 'API Pagos', kind: 'service' },
  { key: 'sap', name: 'SAP', kind: 'service' },
  { key: 'postgres', name: 'PostgreSQL', kind: 'database' },
];

export const GRAPH_EXAMPLE_EDGES: GraphLink[] = [
  { fromKey: 'sw-core', toKey: 'app-01' },
  { fromKey: 'sw-core', toKey: 'app-02' },
  { fromKey: 'sw-core', toKey: 'db-01' },
  { fromKey: 'app-01', toKey: 'api-pagos' },
  { fromKey: 'app-02', toKey: 'sap' },
  { fromKey: 'db-01', toKey: 'postgres' },
];
