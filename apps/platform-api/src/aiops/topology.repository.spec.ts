jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { GRAPH_EXAMPLE_EDGES, GRAPH_EXAMPLE_NODES } from './graph-example';
import { GraphService } from './graph.service';
import { commonCover, sharePath, walk } from './graph-walk';
import { PostgresTopologyRepository } from './topology.postgres.repository';
import { TOPOLOGY_RELATIONS, isTopologyRelation } from './topology.repository';

const NOW = new Date('2026-09-04T12:00:00.000Z');

type NodeRow = {
  id: string;
  tenantId: string;
  siteId: string;
  nodeKey: string;
  kind: string;
  name: string;
  source: string;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type EdgeRow = {
  id: string;
  tenantId: string;
  siteId: string;
  fromKey: string;
  toKey: string;
  relation: string;
  source: string;
  confidence: number | null;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

function node(
  tenantId: string,
  siteId: string,
  key: string,
  kind = 'device',
  name = key,
): NodeRow {
  return {
    id: `n-${tenantId}-${key}`,
    tenantId,
    siteId,
    nodeKey: key,
    kind,
    name,
    source: 'test',
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function edge(
  tenantId: string,
  siteId: string,
  fromKey: string,
  toKey: string,
  relation: string,
  source = 'test',
  confidence: number | null = null,
): EdgeRow {
  return {
    id: `e-${tenantId}-${fromKey}-${toKey}-${relation}-${source}`,
    tenantId,
    siteId,
    fromKey,
    toKey,
    relation,
    source,
    confidence,
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function matchesWhere(
  row: Record<string, unknown>,
  where: Record<string, unknown> = {},
): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === 'OR' && Array.isArray(value)) {
      const ok = value.some((clause) =>
        matchesWhere(row, clause as Record<string, unknown>),
      );
      if (!ok) return false;
      continue;
    }
    if (value && typeof value === 'object' && 'in' in value) {
      const allowed = (value as { in: unknown[] }).in;
      if (!allowed.includes(row[key])) return false;
      continue;
    }
    if (row[key] !== value) return false;
  }
  return true;
}

function createPrisma(nodes: NodeRow[], edges: EdgeRow[]) {
  return {
    graphNode: {
      findUnique: jest.fn(
        ({
          where,
        }: {
          where: { tenantId_nodeKey: { tenantId: string; nodeKey: string } };
        }) => {
          const { tenantId, nodeKey } = where.tenantId_nodeKey;
          return (
            nodes.find(
              (item) => item.tenantId === tenantId && item.nodeKey === nodeKey,
            ) ?? null
          );
        },
      ),
      findFirst: jest.fn(),
      findMany: jest.fn(({ where }: { where?: Record<string, unknown> }) =>
        nodes.filter((item) => matchesWhere(item, where)),
      ),
      upsert: jest.fn(
        ({
          where,
          create,
          update,
        }: {
          where: { tenantId_nodeKey: { tenantId: string; nodeKey: string } };
          create: NodeRow;
          update: Partial<NodeRow>;
        }) => {
          const { tenantId, nodeKey } = where.tenantId_nodeKey;
          const existing = nodes.find(
            (item) => item.tenantId === tenantId && item.nodeKey === nodeKey,
          );
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const created = {
            ...create,
            id: create.id || `n-${create.tenantId}-${create.nodeKey}`,
            createdAt: create.createdAt ?? NOW,
            updatedAt: NOW,
          };
          nodes.push(created);
          return created;
        },
      ),
    },
    graphEdge: {
      findMany: jest.fn(
        ({
          where,
          select,
        }: {
          where?: Record<string, unknown>;
          select?: Record<string, boolean>;
        }) => {
          const rows = edges.filter((item) => matchesWhere(item, where));
          if (!select) return rows;
          return rows.map((item) => {
            const picked: Record<string, unknown> = {};
            for (const [key, enabled] of Object.entries(select)) {
              if (enabled) picked[key] = item[key as keyof EdgeRow];
            }
            return picked;
          });
        },
      ),
      upsert: jest.fn(
        ({
          where,
          create,
          update,
        }: {
          where: {
            tenantId_fromKey_toKey_relation_source: {
              tenantId: string;
              fromKey: string;
              toKey: string;
              relation: string;
              source: string;
            };
          };
          create: EdgeRow;
          update: Partial<EdgeRow>;
        }) => {
          const key = where.tenantId_fromKey_toKey_relation_source;
          const existing = edges.find(
            (item) =>
              item.tenantId === key.tenantId &&
              item.fromKey === key.fromKey &&
              item.toKey === key.toKey &&
              item.relation === key.relation &&
              item.source === key.source,
          );
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const created = {
            ...create,
            id: create.id || `e-${create.fromKey}-${create.toKey}`,
            createdAt: create.createdAt ?? NOW,
            updatedAt: NOW,
            confidence: create.confidence ?? null,
          };
          edges.push(created);
          return created;
        },
      ),
    },
  };
}

function repository(nodes: NodeRow[], edges: EdgeRow[]) {
  const prisma = createPrisma(nodes, edges);
  const graph = new GraphService(prisma as never);
  return {
    prisma,
    graph,
    topology: new PostgresTopologyRepository(graph),
  };
}

describe('TopologyRepository', () => {
  const tenantA = 'tenant-a';
  const tenantB = 'tenant-b';
  const site = 'site-1';

  function cmdb() {
    const nodes = [
      node(tenantA, site, 'checkout', 'service', 'Checkout'),
      node(tenantA, site, 'api', 'service', 'API'),
      node(tenantA, site, 'postgres', 'database', 'PostgreSQL'),
      node(tenantA, site, 'host-01', 'host', 'Host 01'),
      node(tenantA, site, 'sw-core', 'switch', 'Core switch'),
      node(tenantB, site, 'checkout', 'service', 'Otro checkout'),
      node(tenantB, site, 'postgres', 'database', 'Otro postgres'),
    ];
    const edges = [
      edge(
        tenantA,
        site,
        'checkout',
        'api',
        TOPOLOGY_RELATIONS.DEPENDS_ON,
        'k8s',
        0.9,
      ),
      edge(
        tenantA,
        site,
        'api',
        'postgres',
        TOPOLOGY_RELATIONS.DEPENDS_ON,
        'k8s',
        0.8,
      ),
      edge(
        tenantA,
        site,
        'api',
        'host-01',
        TOPOLOGY_RELATIONS.RUNS_ON,
        'k8s',
        0.95,
      ),
      edge(
        tenantA,
        site,
        'host-01',
        'api',
        TOPOLOGY_RELATIONS.HOSTS,
        'k8s',
        0.95,
      ),
      edge(
        tenantA,
        site,
        'sw-core',
        'host-01',
        TOPOLOGY_RELATIONS.CONNECTS_TO,
        'lldp',
      ),
      edge(
        tenantB,
        site,
        'checkout',
        'postgres',
        TOPOLOGY_RELATIONS.DEPENDS_ON,
      ),
    ];
    return repository(nodes, edges);
  }

  it('expone tipos de relación como constantes, no literales sueltos', () => {
    expect(isTopologyRelation(TOPOLOGY_RELATIONS.CONNECTS_TO)).toBe(true);
    expect(isTopologyRelation(TOPOLOGY_RELATIONS.RUNS_ON)).toBe(true);
    expect(isTopologyRelation('UNKNOWN')).toBe(false);
  });

  it('getEntity mapea GraphNode y aísla por tenant', async () => {
    const { topology } = cmdb();
    const entity = await topology.getEntity(tenantA, 'api');
    expect(entity?.entityKey).toBe('api');
    expect(entity?.name).toBe('API');
    expect(entity?.tenantId).toBe(tenantA);

    const foreign = await topology.getEntity(tenantB, 'api');
    expect(foreign).toBeNull();
  });

  it('getDependencies sigue DEPENDS_ON, RUNS_ON y HOSTS inverso', async () => {
    const { topology } = cmdb();
    const deps = await topology.getDependencies(tenantA, 'api');
    const keys = [...new Set(deps.map((item) => item.entity.entityKey))].sort();
    expect(keys).toEqual(['host-01', 'postgres']);
    expect(deps.every((item) => item.entity.tenantId === tenantA)).toBe(true);
  });

  it('getDependents incluye quien depende de la entidad', async () => {
    const { topology } = cmdb();
    const dependents = await topology.getDependents(tenantA, 'api');
    const keys = dependents.map((item) => item.entity.entityKey).sort();
    expect(keys).toEqual(['checkout']);
  });

  it('getAncestors camina la jerarquía dirigida', async () => {
    const { topology } = cmdb();
    const ancestors = await topology.getAncestors(tenantA, 'checkout');
    expect(ancestors.map((item) => item.entityKey)).toEqual(
      expect.arrayContaining(['api', 'postgres', 'host-01']),
    );
    expect(ancestors.some((item) => item.tenantId !== tenantA)).toBe(false);
  });

  it('getDescendants camina dependientes', async () => {
    const { topology } = cmdb();
    const descendants = await topology.getDescendants(tenantA, 'postgres');
    expect(descendants.map((item) => item.entityKey)).toEqual(
      expect.arrayContaining(['api', 'checkout']),
    );
  });

  it('getPath resuelve CONNECTSTO de LLDP de forma no dirigida', async () => {
    const { topology } = cmdb();
    const path = await topology.getPath(tenantA, 'sw-core', 'host-01');
    expect(path?.map((item) => item.entityKey)).toEqual(['sw-core', 'host-01']);
  });

  it('getPath no cruza tenants ni grafos desconectados', async () => {
    const { topology } = cmdb();
    await expect(
      topology.getPath(tenantA, 'checkout', 'inexistente'),
    ).resolves.toBeNull();
    const leaked = await topology.getPath(tenantA, 'checkout', 'postgres');
    expect(leaked?.some((item) => item.tenantId !== tenantA)).toBe(false);
  });

  it('getCommonAncestor elige el ancestro dirigido más cercano', async () => {
    const { topology } = cmdb();
    const ancestor = await topology.getCommonAncestor(tenantA, [
      'checkout',
      'postgres',
    ]);
    expect(ancestor?.entityKey).toBe('postgres');
  });

  it('getCommonAncestor cae al cover no dirigido en grafos solo CONNECTS_TO', async () => {
    const nodes = GRAPH_EXAMPLE_NODES.map((item) =>
      node(tenantA, site, item.key, item.kind, item.name),
    );
    const edges = GRAPH_EXAMPLE_EDGES.map((item) =>
      edge(
        tenantA,
        site,
        item.fromKey,
        item.toKey,
        TOPOLOGY_RELATIONS.CONNECTS_TO,
        'example',
      ),
    );
    const { topology } = repository(nodes, edges);
    const ancestor = await topology.getCommonAncestor(tenantA, [
      'api-pagos',
      'sap',
      'postgres',
    ]);
    expect(ancestor?.entityKey).toBe('sw-core');
  });

  it('findRelatedEntities lista vecinos de 1 hop con dirección', async () => {
    const { topology } = cmdb();
    const related = await topology.findRelatedEntities(tenantA, 'api');
    expect(
      [...new Set(related.map((item) => item.entity.entityKey))].sort(),
    ).toEqual(['checkout', 'host-01', 'postgres']);
    expect(related.length).toBeGreaterThanOrEqual(3);
    const checkout = related.find(
      (item) => item.entity.entityKey === 'checkout',
    );
    expect(checkout?.direction).toBe('incoming');
    expect(checkout?.relationship.relation).toBe(TOPOLOGY_RELATIONS.DEPENDS_ON);
    expect(checkout?.relationship.firstSeenAt).toEqual(NOW);
  });

  it('findRelatedEntities filtra por tipo de relación', async () => {
    const { topology } = cmdb();
    const related = await topology.findRelatedEntities(tenantA, 'api', {
      relations: [TOPOLOGY_RELATIONS.RUNS_ON],
    });
    expect(related).toHaveLength(1);
    expect(related[0]?.entity.entityKey).toBe('host-01');
    expect(related[0]?.relationship.relation).toBe(TOPOLOGY_RELATIONS.RUNS_ON);
  });

  it('todas las queries incluyen tenantId y no filtran el otro tenant', async () => {
    const { topology, prisma } = cmdb();
    await topology.getEntity(tenantA, 'api');
    await topology.getDependencies(tenantA, 'api');
    await topology.findRelatedEntities(tenantA, 'api');
    await topology.getAncestors(tenantA, 'checkout');

    for (const call of prisma.graphEdge.findMany.mock.calls) {
      const where = call[0]?.where as { tenantId?: string } | undefined;
      expect(where?.tenantId).toBe(tenantA);
    }
    for (const call of prisma.graphNode.findMany.mock.calls) {
      const where = call[0]?.where as { tenantId?: string } | undefined;
      expect(where?.tenantId).toBe(tenantA);
    }
    expect(prisma.graphNode.findUnique).toHaveBeenCalledWith({
      where: { tenantId_nodeKey: { tenantId: tenantA, nodeKey: 'api' } },
    });
  });

  it('GraphService.upsertNeighbor sigue persistiendo CONNECTS_TO para LLDP', async () => {
    const nodes: NodeRow[] = [];
    const edges: EdgeRow[] = [];
    const { graph } = repository(nodes, edges);
    await graph.upsertNeighbor(tenantA, {
      siteId: site,
      fromKey: 'sw-a',
      fromName: 'Switch A',
      fromKind: 'switch',
      toKey: 'sw-b',
      toName: 'Switch B',
      toKind: 'switch',
      source: 'lldp',
      seenAt: NOW,
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.relation).toBe(TOPOLOGY_RELATIONS.CONNECTS_TO);
    expect(edges[0]?.source).toBe('lldp');
    const links = await graph.links(tenantA, site);
    expect(links).toEqual([{ fromKey: 'sw-a', toKey: 'sw-b' }]);
    expect(sharePath('sw-a', 'sw-b', links, 1)).toBe(true);
  });

  it('GraphService.upsertRelation guarda confidence y no rompe el walk existente', async () => {
    const nodes: NodeRow[] = [];
    const edges: EdgeRow[] = [];
    const { graph } = repository(nodes, edges);
    await graph.upsertRelation(tenantA, {
      siteId: site,
      fromKey: 'pod',
      toKey: 'node',
      relation: TOPOLOGY_RELATIONS.RUNS_ON,
      source: 'k8s',
      seenAt: NOW,
      confidence: 0.88,
    });
    expect(edges[0]?.relation).toBe(TOPOLOGY_RELATIONS.RUNS_ON);
    expect(edges[0]?.confidence).toBe(0.88);
    const links = await graph.links(tenantA);
    expect(walk('pod', links, 1).has('node')).toBe(true);
    expect(commonCover(['pod', 'node'], links, 2)).toBeTruthy();
  });
});
