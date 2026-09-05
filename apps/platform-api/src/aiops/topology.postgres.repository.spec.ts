jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { GRAPH_EXAMPLE_EDGES, GRAPH_EXAMPLE_NODES } from './graph-example';
import { GraphService } from './graph.service';
import { commonCover, sharePath, walk } from './graph-walk';
import { PostgresTopologyRepository } from './topology.postgres.repository';
import { TOPOLOGY_RELATIONS } from './topology.relations';

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

function matchWhere(
  row: Record<string, unknown>,
  where: Record<string, unknown> | undefined,
): boolean {
  if (!where) return true;
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === 'AND' && Array.isArray(value)) {
      if (
        !value.every((part) => matchWhere(row, part as Record<string, unknown>))
      ) {
        return false;
      }
      continue;
    }
    if (key === 'OR' && Array.isArray(value)) {
      if (
        !value.some((part) => matchWhere(row, part as Record<string, unknown>))
      ) {
        return false;
      }
      continue;
    }
    if (value && typeof value === 'object' && 'in' in value) {
      if (!(value.in as unknown[]).includes(row[key])) return false;
      continue;
    }
    if (row[key] !== value) return false;
  }
  return true;
}

function createMemoryPrisma() {
  const nodes: NodeRow[] = [];
  const edges: EdgeRow[] = [];
  let seq = 0;
  const nextId = (prefix: string) => {
    seq += 1;
    return `${prefix}-${seq}`;
  };

  return {
    graphNode: {
      findUnique: ({
        where,
      }: {
        where: { tenantId_nodeKey: { tenantId: string; nodeKey: string } };
      }) => {
        const { tenantId, nodeKey } = where.tenantId_nodeKey;
        return Promise.resolve(
          nodes.find(
            (row) => row.tenantId === tenantId && row.nodeKey === nodeKey,
          ) ?? null,
        );
      },
      findMany: ({ where }: { where?: Record<string, unknown> }) =>
        Promise.resolve(
          nodes.filter((row) =>
            matchWhere(row as unknown as Record<string, unknown>, where),
          ),
        ),
      upsert: ({
        where,
        create,
        update,
      }: {
        where: { tenantId_nodeKey: { tenantId: string; nodeKey: string } };
        create: Omit<NodeRow, 'id' | 'createdAt' | 'updatedAt'> & {
          createdAt?: Date;
          updatedAt?: Date;
        };
        update: Partial<NodeRow>;
      }) => {
        const { tenantId, nodeKey } = where.tenantId_nodeKey;
        const existing = nodes.find(
          (row) => row.tenantId === tenantId && row.nodeKey === nodeKey,
        );
        const now = new Date();
        if (!existing) {
          const row: NodeRow = {
            ...create,
            id: nextId('n'),
            createdAt: create.lastSeenAt ?? now,
            updatedAt: now,
          };
          nodes.push(row);
          return Promise.resolve(row);
        }
        Object.assign(existing, update, { updatedAt: now });
        return Promise.resolve(existing);
      },
    },
    graphEdge: {
      findMany: ({ where }: { where?: Record<string, unknown> }) =>
        Promise.resolve(
          edges.filter((row) =>
            matchWhere(row as unknown as Record<string, unknown>, where),
          ),
        ),
      upsert: ({
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
        create: Omit<EdgeRow, 'id' | 'createdAt' | 'updatedAt'> & {
          createdAt?: Date;
          updatedAt?: Date;
        };
        update: Partial<EdgeRow>;
      }) => {
        const key = where.tenantId_fromKey_toKey_relation_source;
        const existing = edges.find(
          (row) =>
            row.tenantId === key.tenantId &&
            row.fromKey === key.fromKey &&
            row.toKey === key.toKey &&
            row.relation === key.relation &&
            row.source === key.source,
        );
        const now = new Date();
        if (!existing) {
          const row: EdgeRow = {
            ...create,
            id: nextId('e'),
            confidence: create.confidence ?? null,
            createdAt: create.lastSeenAt ?? now,
            updatedAt: now,
          };
          edges.push(row);
          return Promise.resolve(row);
        }
        Object.assign(existing, update, { updatedAt: now });
        return Promise.resolve(existing);
      },
    },
  };
}

function build() {
  const prisma = createMemoryPrisma();
  const graph = new GraphService(prisma as never);
  const topology = new PostgresTopologyRepository(graph);
  return { prisma, graph, topology };
}

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const SITE = 'site-1';
const seenAt = new Date('2026-09-04T12:00:00Z');

async function seedLldp(graph: GraphService, tenantId: string, siteId = SITE) {
  const byKey = new Map(GRAPH_EXAMPLE_NODES.map((item) => [item.key, item]));
  for (const edge of GRAPH_EXAMPLE_EDGES) {
    const from = byKey.get(edge.fromKey);
    const to = byKey.get(edge.toKey);
    if (!from || !to) continue;
    await graph.upsertNeighbor(tenantId, {
      siteId,
      fromKey: from.key,
      fromName: from.name,
      fromKind: from.kind,
      toKey: to.key,
      toName: to.name,
      toKind: to.kind,
      source: 'lldp',
      seenAt,
    });
  }
}

async function seedCmdb(graph: GraphService, tenantId: string) {
  await graph.upsertRelation(tenantId, {
    siteId: SITE,
    fromKey: 'pod-a',
    fromName: 'pod-a',
    fromKind: 'K8S_POD',
    toKey: 'host-1',
    toName: 'host-1',
    toKind: 'host',
    source: 'k8s',
    seenAt,
    relation: TOPOLOGY_RELATIONS.RUNS_ON,
    confidence: 0.9,
  });
  await graph.upsertRelation(tenantId, {
    siteId: SITE,
    fromKey: 'svc-api',
    fromName: 'api',
    fromKind: 'service',
    toKey: 'svc-db',
    toName: 'db',
    toKind: 'service',
    source: 'cmdb',
    seenAt,
    relation: TOPOLOGY_RELATIONS.DEPENDS_ON,
    confidence: 0.8,
  });
  await graph.upsertRelation(tenantId, {
    siteId: SITE,
    fromKey: 'svc-api',
    fromName: 'api',
    fromKind: 'service',
    toKey: 'host-1',
    toName: 'host-1',
    toKind: 'host',
    source: 'k8s',
    seenAt,
    relation: TOPOLOGY_RELATIONS.RUNS_ON,
  });
  await graph.upsertRelation(tenantId, {
    siteId: SITE,
    fromKey: 'host-1',
    fromName: 'host-1',
    fromKind: 'host',
    toKey: 'pod-b',
    toName: 'pod-b',
    toKind: 'K8S_POD',
    source: 'k8s',
    seenAt,
    relation: TOPOLOGY_RELATIONS.HOSTS,
  });
}

describe('PostgresTopologyRepository', () => {
  it('aísla getEntity por tenant', async () => {
    const { graph, topology } = build();
    await graph.upsertNeighbor(TENANT_A, {
      siteId: SITE,
      fromKey: 'sw-core',
      toKey: 'app-01',
      source: 'lldp',
      seenAt,
    });
    await graph.upsertNeighbor(TENANT_B, {
      siteId: SITE,
      fromKey: 'sw-core',
      fromName: 'core-b',
      toKey: 'app-99',
      source: 'lldp',
      seenAt,
    });

    const fromA = await topology.getEntity(TENANT_A, 'sw-core');
    const fromB = await topology.getEntity(TENANT_B, 'sw-core');
    const missing = await topology.getEntity(TENANT_A, 'app-99');

    expect(fromA?.name).toBe('sw-core');
    expect(fromB?.name).toBe('core-b');
    expect(fromA?.tenantId).toBe(TENANT_A);
    expect(fromB?.tenantId).toBe(TENANT_B);
    expect(missing).toBeNull();
  });

  it('sigue escribiendo CONNECTS_TO en vecinos LLDP', async () => {
    const { graph, topology } = build();
    await seedLldp(graph, TENANT_A);

    const related = await topology.findRelatedEntities(TENANT_A, 'sw-core');
    expect(
      related.every(
        (item) => item.relationship.relation === TOPOLOGY_RELATIONS.CONNECTS_TO,
      ),
    ).toBe(true);
    expect(related.map((item) => item.entity.entityKey).sort()).toEqual([
      'app-01',
      'app-02',
      'db-01',
    ]);
  });

  it('no mezcla aristas de otro tenant en consultas', async () => {
    const { graph, topology } = build();
    await seedLldp(graph, TENANT_A);
    await graph.upsertRelation(TENANT_B, {
      siteId: SITE,
      fromKey: 'api-pagos',
      toKey: 'postgres',
      source: 'cmdb',
      seenAt,
      relation: TOPOLOGY_RELATIONS.DEPENDS_ON,
    });

    const deps = await topology.getDependencies(TENANT_A, 'api-pagos');
    const path = await topology.getPath(TENANT_A, 'api-pagos', 'postgres');
    expect(deps).toEqual([]);
    expect(path?.map((node) => node.entityKey)).toEqual([
      'api-pagos',
      'app-01',
      'sw-core',
      'db-01',
      'postgres',
    ]);
  });

  it('resuelve dependencias y dependientes dirigidos', async () => {
    const { graph, topology } = build();
    await seedCmdb(graph, TENANT_A);

    const deps = await topology.getDependencies(TENANT_A, 'svc-api');
    const dependents = await topology.getDependents(TENANT_A, 'svc-db');
    expect(deps.map((item) => item.entity.entityKey).sort()).toEqual([
      'host-1',
      'svc-db',
    ]);
    expect(
      deps.find((item) => item.entity.entityKey === 'svc-db')?.relationship
        .confidence,
    ).toBe(0.8);
    expect(dependents.map((item) => item.entity.entityKey)).toEqual([
      'svc-api',
    ]);
  });

  it('elige el ancestro dirigido más cercano (no el cover L2)', async () => {
    const { graph, topology } = build();
    await seedCmdb(graph, TENANT_A);
    await graph.upsertRelation(TENANT_A, {
      siteId: SITE,
      fromKey: 'checkout',
      fromName: 'checkout',
      fromKind: 'service',
      toKey: 'svc-api',
      toName: 'api',
      toKind: 'service',
      source: 'cmdb',
      seenAt,
      relation: TOPOLOGY_RELATIONS.DEPENDS_ON,
    });
    const ancestor = await topology.getCommonAncestor(TENANT_A, [
      'checkout',
      'svc-db',
    ]);
    expect(ancestor?.entityKey).toBe('svc-db');
  });

  it('recorre ancestros y descendientes (RUNS_ON / HOSTS)', async () => {
    const { graph, topology } = build();
    await seedCmdb(graph, TENANT_A);

    const ancestors = await topology.getAncestors(TENANT_A, 'pod-a');
    const descendants = await topology.getDescendants(TENANT_A, 'host-1');
    expect(ancestors.map((item) => item.entityKey)).toEqual(['host-1']);
    expect(descendants.map((item) => item.entityKey).sort()).toEqual([
      'pod-a',
      'pod-b',
      'svc-api',
    ]);
  });

  it('usa commonCover sobre CONNECTS_TO cuando no hay jerarquía', async () => {
    const { graph, topology } = build();
    await seedLldp(graph, TENANT_A);

    const ancestor = await topology.getCommonAncestor(TENANT_A, [
      'api-pagos',
      'sap',
      'postgres',
    ]);
    expect(ancestor?.entityKey).toBe('sw-core');
  });

  it('expone firstSeen desde createdAt y no inventa columnas', async () => {
    const { graph, topology } = build();
    await seedCmdb(graph, TENANT_A);
    const related = await topology.findRelatedEntities(TENANT_A, 'svc-api', {
      relations: [TOPOLOGY_RELATIONS.DEPENDS_ON],
    });
    expect(related).toHaveLength(1);
    expect(related[0].relationship.firstSeenAt).toEqual(seenAt);
    expect(related[0].relationship.lastSeenAt).toEqual(seenAt);
    expect(related[0].relationship.source).toBe('cmdb');
  });

  it('mantiene graph-walk sobre las mismas aristas LLDP', async () => {
    const { graph } = build();
    await seedLldp(graph, TENANT_A);
    const links = await graph.links(TENANT_A, SITE);
    expect(walk('sw-core', links, 2).has('api-pagos')).toBe(true);
    expect(sharePath('api-pagos', 'postgres', links, 4)).toBe(true);
    expect(commonCover(['api-pagos', 'sap', 'postgres'], links, 4)).toBe(
      'sw-core',
    );
  });

  it('snapshot sigue exponiendo from/to/relation para Cytoscape', async () => {
    const { graph } = build();
    await seedLldp(graph, TENANT_A);
    const snapshot = await graph.snapshot(TENANT_A, SITE);
    const edge = snapshot.edges[0];
    const node = snapshot.nodes[0];
    expect(edge.from.length).toBeGreaterThan(0);
    expect(edge.to.length).toBeGreaterThan(0);
    expect(edge.relation).toBe(TOPOLOGY_RELATIONS.CONNECTS_TO);
    expect(edge.source).toBe('lldp');
    expect(edge.siteId).toBe(SITE);
    expect(node.key.length).toBeGreaterThan(0);
    expect(node.name.length).toBeGreaterThan(0);
    expect(node.kind.length).toBeGreaterThan(0);
    expect(node.siteId).toBe(SITE);
  });
});
