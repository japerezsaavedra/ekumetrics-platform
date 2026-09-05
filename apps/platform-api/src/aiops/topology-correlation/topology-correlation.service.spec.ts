import { CorrelationMetrics } from '../correlation-metrics';
import { CorrelationService, type CorrelateAlert } from '../correlation.service';
import { commonCover, type GraphLink } from '../graph-walk';
import {
  ancestorDistances,
  matchesRole,
  pickClosest,
  relatedWithinHops,
  roleNeighbor,
  shortestPath,
  walkDirected,
} from '../topology-walk';
import { TOPOLOGY_DEFAULT_HOPS, TOPOLOGY_RELATIONS } from '../topology.relations';
import type {
  RelatedEntity,
  TopologyEntity,
  TopologyQueryOptions,
  TopologyRelationship,
  TopologyRepository,
} from '../topology.repository';
import { TopologyCorrelationMetrics } from './topology-correlation.metrics';
import { TopologyCorrelationService } from './topology-correlation.service';
import type { TopologyAlertItem } from './topology-correlation.types';
import { EventBusUnavailableError, EventSubjects } from '../../messaging';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const SITE = 'santiago';

const { CONNECTS_TO, DEPENDS_ON, RUNS_ON } = TOPOLOGY_RELATIONS;

function now(): Date {
  return new Date('2026-09-05T12:00:00.000Z');
}

function entity(
  tenantId: string,
  entityKey: string,
  kind: string,
  name: string,
): TopologyEntity {
  const at = now();
  return {
    id: `${tenantId}:${entityKey}`,
    tenantId,
    siteId: SITE,
    entityKey,
    kind,
    name,
    source: 'test',
    lastSeenAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

function rel(
  tenantId: string,
  fromKey: string,
  toKey: string,
  relation: string,
  source: string,
  confidence: number | null,
): TopologyRelationship {
  const at = now();
  return {
    id: `${tenantId}:${fromKey}:${toKey}:${relation}:${source}`,
    tenantId,
    siteId: SITE,
    fromKey,
    toKey,
    relation,
    source,
    confidence,
    firstSeenAt: at,
    lastSeenAt: at,
  };
}

function sw03Graph(tenantId: string): {
  nodes: TopologyEntity[];
  edges: TopologyRelationship[];
} {
  return {
    nodes: [
      entity(tenantId, 'sw-03', 'switch', 'Switch SW-03'),
      entity(tenantId, 'srv-01', 'host', 'Server SRV-01'),
      entity(tenantId, 'k8s-node-a', 'node', 'K8s node A'),
      entity(tenantId, 'api-checkout', 'service', 'API checkout'),
      entity(tenantId, 'app-checkout', 'application', 'App checkout'),
      entity(tenantId, 'printer-01', 'device', 'Printer 01'),
      entity(tenantId, 'ups-02', 'device', 'UPS 02'),
    ],
    edges: [
      rel(tenantId, 'srv-01', 'sw-03', CONNECTS_TO, 'lldp', 0.7),
      rel(tenantId, 'srv-01', 'sw-03', CONNECTS_TO, 'otel', 0.65),
      rel(tenantId, 'srv-01', 'sw-03', CONNECTS_TO, 'cmdb', 0.85),
      rel(tenantId, 'k8s-node-a', 'srv-01', RUNS_ON, 'cmdb', 0.8),
      rel(tenantId, 'api-checkout', 'k8s-node-a', RUNS_ON, 'otel', 0.75),
      rel(tenantId, 'app-checkout', 'api-checkout', DEPENDS_ON, 'cmdb', 0.8),
    ],
  };
}

class FakeTopologyRepository implements TopologyRepository {
  readonly queriedTenants = new Set<string>();

  constructor(
    private readonly nodes: TopologyEntity[],
    private readonly edges: TopologyRelationship[],
  ) {}

  async getEntity(tenantId: string, entityKey: string) {
    this.queriedTenants.add(tenantId);
    if (!entityKey) return null;
    return (
      this.nodes.find(
        (row) => row.tenantId === tenantId && row.entityKey === entityKey,
      ) ?? null
    );
  }

  async getDependencies(
    tenantId: string,
    entityKey: string,
    options?: TopologyQueryOptions,
  ) {
    return this.relatedByRole(tenantId, entityKey, 'dependencies', options);
  }

  async getDependents(
    tenantId: string,
    entityKey: string,
    options?: TopologyQueryOptions,
  ) {
    return this.relatedByRole(tenantId, entityKey, 'dependents', options);
  }

  async getAncestors(
    tenantId: string,
    entityKey: string,
    options?: TopologyQueryOptions,
  ) {
    this.queriedTenants.add(tenantId);
    const hops = options?.hops ?? TOPOLOGY_DEFAULT_HOPS;
    const keys = walkDirected(
      entityKey,
      this.load(tenantId, options),
      hops,
      'dependencies',
      options,
    );
    return this.hydrate(tenantId, keys);
  }

  async getDescendants(
    tenantId: string,
    entityKey: string,
    options?: TopologyQueryOptions,
  ) {
    this.queriedTenants.add(tenantId);
    const hops = options?.hops ?? TOPOLOGY_DEFAULT_HOPS;
    const keys = walkDirected(
      entityKey,
      this.load(tenantId, options),
      hops,
      'dependents',
      options,
    );
    return this.hydrate(tenantId, keys);
  }

  async getPath(
    tenantId: string,
    fromKey: string,
    toKey: string,
    options?: TopologyQueryOptions,
  ) {
    this.queriedTenants.add(tenantId);
    if (!fromKey || !toKey) return null;
    const hops = options?.hops ?? TOPOLOGY_DEFAULT_HOPS;
    if (fromKey === toKey) {
      const origin = await this.getEntity(tenantId, fromKey);
      return origin ? [origin] : null;
    }
    const path = shortestPath(
      fromKey,
      toKey,
      this.load(tenantId, options),
      hops,
      options,
    );
    if (!path) return null;
    const nodes = await this.hydrate(tenantId, path);
    const byKey = new Map(nodes.map((item) => [item.entityKey, item]));
    const ordered = path
      .map((key) => byKey.get(key))
      .filter((item): item is TopologyEntity => Boolean(item));
    return ordered.length === path.length ? ordered : null;
  }

  async getCommonAncestor(
    tenantId: string,
    entityKeys: string[],
    options?: TopologyQueryOptions,
  ) {
    this.queriedTenants.add(tenantId);
    const unique = [...new Set(entityKeys.filter(Boolean))];
    if (unique.length === 0) return null;
    if (unique.length === 1) return this.getEntity(tenantId, unique[0]);
    const hops = options?.hops ?? TOPOLOGY_DEFAULT_HOPS;
    const edges = this.load(tenantId, options);
    const distances = unique.map((key) =>
      ancestorDistances(key, edges, hops, options),
    );
    const candidates = [...distances[0].keys()].filter((key) =>
      distances.every((map) => map.has(key)),
    );
    if (candidates.length > 0) {
      const best = pickClosest(candidates, distances);
      return best ? this.getEntity(tenantId, best) : null;
    }
    const links: GraphLink[] = edges.map((edge) => ({
      fromKey: edge.fromKey,
      toKey: edge.toKey,
    }));
    const cover = commonCover(unique, links, hops);
    return cover ? this.getEntity(tenantId, cover) : null;
  }

  async findRelatedEntities(
    tenantId: string,
    entityKey: string,
    options?: TopologyQueryOptions,
  ) {
    this.queriedTenants.add(tenantId);
    if (!entityKey) return [];
    const hops = options?.hops ?? 1;
    const origin = await this.getEntity(tenantId, entityKey);
    if (!origin) return [];
    const edges = this.load(tenantId, options);
    const found = relatedWithinHops(entityKey, edges, hops, options);
    const nodes = await this.hydrate(
      tenantId,
      found.map((item) => item.key),
    );
    const byKey = new Map(nodes.map((item) => [item.entityKey, item]));
    const related: RelatedEntity[] = [];
    for (const item of found) {
      const row = byKey.get(item.key);
      if (!row) continue;
      related.push({
        entity: row,
        relationship: item.edge,
        direction: item.edge.fromKey === item.viaKey ? 'outgoing' : 'incoming',
      });
    }
    return related;
  }

  private relatedByRole(
    tenantId: string,
    entityKey: string,
    role: 'dependencies' | 'dependents',
    options?: TopologyQueryOptions,
  ): Promise<RelatedEntity[]> {
    this.queriedTenants.add(tenantId);
    if (!entityKey) return Promise.resolve([]);
    const matched = this.load(tenantId, options).filter((edge) =>
      matchesRole(entityKey, edge, role, options),
    );
    return this.hydrate(
      tenantId,
      matched.map((edge) => roleNeighbor(entityKey, edge, role)),
    ).then((nodes) => {
      const byKey = new Map(nodes.map((item) => [item.entityKey, item]));
      const related: RelatedEntity[] = [];
      for (const edge of matched) {
        const neighbor = byKey.get(roleNeighbor(entityKey, edge, role));
        if (!neighbor) continue;
        related.push({
          entity: neighbor,
          relationship: edge,
          direction: edge.fromKey === entityKey ? 'outgoing' : 'incoming',
        });
      }
      return related;
    });
  }

  private load(tenantId: string, options?: TopologyQueryOptions) {
    return this.edges.filter((edge) => {
      if (edge.tenantId !== tenantId) return false;
      if (options?.siteId && edge.siteId !== options.siteId) return false;
      if (options?.relations?.length && !options.relations.includes(edge.relation)) {
        return false;
      }
      return true;
    });
  }

  private hydrate(tenantId: string, keys: string[]): Promise<TopologyEntity[]> {
    const unique = [...new Set(keys.filter(Boolean))];
    const order = new Map(unique.map((key, index) => [key, index]));
    return Promise.resolve(
      this.nodes
        .filter(
          (row) => row.tenantId === tenantId && unique.includes(row.entityKey),
        )
        .sort(
          (left, right) =>
            (order.get(left.entityKey) ?? 0) - (order.get(right.entityKey) ?? 0),
        ),
    );
  }
}

function alertItem(
  fingerprint: string,
  nodeKey: string,
  startsAt = '2026-09-05T12:00:00.000Z',
): TopologyAlertItem {
  return {
    alert: {
      fingerprint,
      name: fingerprint,
      severity: 'critical',
      siteId: SITE,
      nodeHint: nodeKey,
      startsAt,
    },
    nodeKey,
  };
}

function singletonClusters(items: TopologyAlertItem[]): TopologyAlertItem[][] {
  return items.map((item) => [item]);
}

function configStub(
  env: Record<string, string | undefined> = {},
) {
  return {
    get: (key: string) => env[key],
  } as never;
}

function service(
  repo: FakeTopologyRepository,
  env: Record<string, string | undefined> = {},
  bus?: { publish: jest.Mock },
) {
  const metrics = new TopologyCorrelationMetrics();
  const eventBus = bus ?? { publish: jest.fn().mockResolvedValue({ messageId: 'm1' }) };
  const instance = new TopologyCorrelationService(
    repo,
    configStub(env),
    eventBus as never,
    metrics,
  );
  return { instance, metrics, eventBus };
}

describe('TopologyCorrelationService', () => {
  const graphA = sw03Graph(TENANT_A);
  const graphB = {
    nodes: sw03Graph(TENANT_B).nodes,
    edges: [] as TopologyRelationship[],
  };

  let repo: FakeTopologyRepository;

  beforeEach(() => {
    repo = new FakeTopologyRepository(
      [...graphA.nodes, ...graphB.nodes],
      [...graphA.edges, ...graphB.edges],
    );
  });

  it('detecta el ancestro común (switch SW-03 cubre el cluster)', async () => {
    const ancestor = await repo.getCommonAncestor(TENANT_A, [
      'srv-01',
      'k8s-node-a',
      'api-checkout',
      'app-checkout',
      'sw-03',
    ]);
    expect(ancestor?.tenantId).toBe(TENANT_A);
    expect(['sw-03', 'srv-01']).toContain(ancestor?.entityKey);

    const { instance } = service(repo);
    const result = await instance.apply({
      tenantId: TENANT_A,
      tenantSlug: 'cliente-a',
      clusters: singletonClusters([
        alertItem('fp-sw', 'sw-03'),
        alertItem('fp-srv', 'srv-01'),
        alertItem('fp-k8s', 'k8s-node-a'),
        alertItem('fp-api', 'api-checkout'),
        alertItem('fp-app', 'app-checkout'),
      ]),
      hops: 4,
      windowMs: 300_000,
    });
    expect(result.clusters).toHaveLength(1);
    expect(result.enrichments[0].topologyEvidence.commonAncestorKey).toBe(
      'sw-03',
    );
    expect(result.enrichments[0].topologyEvidence.tenantId).toBe(TENANT_A);
  });

  it('calcula blast radius estructurado desde SW-03', async () => {
    const { instance } = service(repo);
    const result = await instance.apply({
      tenantId: TENANT_A,
      tenantSlug: 'cliente-a',
      clusters: [
        [
          alertItem('fp-sw', 'sw-03'),
          alertItem('fp-srv', 'srv-01'),
          alertItem('fp-k8s', 'k8s-node-a'),
          alertItem('fp-api', 'api-checkout'),
          alertItem('fp-app', 'app-checkout'),
        ],
      ],
      hops: 4,
      windowMs: 300_000,
    });
    const blast = result.enrichments[0].blastRadius;
    expect(blast?.originKey).toBe('sw-03');
    expect(blast?.directDependents.map((node) => node.entityKey)).toEqual(
      expect.arrayContaining(['srv-01']),
    );
    expect(blast?.indirectDependents.map((node) => node.entityKey)).toEqual(
      expect.arrayContaining(['k8s-node-a', 'api-checkout', 'app-checkout']),
    );
    expect(blast?.affectedServices.map((node) => node.entityKey)).toEqual(
      expect.arrayContaining(['api-checkout']),
    );
    expect(blast?.affectedApplications.map((node) => node.entityKey)).toEqual(
      expect.arrayContaining(['app-checkout']),
    );
    expect(
      result.enrichments[0].topologyEvidence.impactPropagation?.nodes.length,
    ).toBeGreaterThan(0);
  });

  it('suprime incidentes independientes de alta prioridad cuando SW-03 cae', async () => {
    const { instance, metrics } = service(repo);
    const result = await instance.apply({
      tenantId: TENANT_A,
      tenantSlug: 'cliente-a',
      clusters: singletonClusters([
        alertItem('fp-srv', 'srv-01'),
        alertItem('fp-k8s', 'k8s-node-a'),
        alertItem('fp-api', 'api-checkout'),
        alertItem('fp-app', 'app-checkout'),
      ]),
      hops: 4,
      windowMs: 300_000,
    });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]).toHaveLength(4);
    expect(result.suppressions).toBe(3);
    const suppression = result.enrichments[0].suppression;
    expect(suppression.applied).toBe(true);
    expect(suppression.evidenceRetained).toBe(true);
    expect(suppression.independentIncidentsSuppressed).toBe(3);
    expect(suppression.suppressedEntityKeys.length).toBeGreaterThan(0);
    expect(metrics.render()).toContain('aiops_topology_correlations_total 1');
    expect(metrics.render()).toContain('aiops_root_cause_suppressions_total 3');
  });

  it('no suprime si la configuración está desactivada', async () => {
    const { instance } = service(repo, {
      AIOPS_ROOT_CAUSE_SUPPRESSION_ENABLED: 'false',
    });
    const result = await instance.apply({
      tenantId: TENANT_A,
      tenantSlug: 'cliente-a',
      clusters: singletonClusters([
        alertItem('fp-srv', 'srv-01'),
        alertItem('fp-k8s', 'k8s-node-a'),
        alertItem('fp-api', 'api-checkout'),
        alertItem('fp-app', 'app-checkout'),
      ]),
      hops: 4,
      windowMs: 300_000,
    });
    expect(result.clusters).toHaveLength(4);
    expect(result.suppressions).toBe(0);
    expect(result.enrichments.every((item) => !item.suppression.applied)).toBe(
      true,
    );
  });

  it('asigna score topológico/causal alto cuando hay camino dirigido', async () => {
    const { instance } = service(repo);
    const result = await instance.apply({
      tenantId: TENANT_A,
      tenantSlug: 'cliente-a',
      clusters: [
        [alertItem('fp-api', 'api-checkout'), alertItem('fp-app', 'app-checkout')],
      ],
      hops: 4,
      windowMs: 300_000,
    });
    const evidence = result.enrichments[0].topologyEvidence;
    expect(evidence.topologyScore).toBeGreaterThan(0.4);
    expect(evidence.causalScore).toBeGreaterThan(0.4);
    expect(evidence.pathScores.length).toBeGreaterThan(0);
  });

  it('agrega confianza de relación recolector+otel+cmdb en el hop SW-03', async () => {
    const { instance } = service(repo);
    const result = await instance.apply({
      tenantId: TENANT_A,
      tenantSlug: 'cliente-a',
      clusters: [[alertItem('fp-srv', 'srv-01'), alertItem('fp-sw', 'sw-03')]],
      hops: 4,
      windowMs: 300_000,
    });
    expect(
      result.enrichments[0].topologyEvidence.relationshipConfidence,
    ).toBeGreaterThanOrEqual(0.7);
  });

  it('falso positivo: cercanas en el tiempo pero sin topología no tienen score causal alto', async () => {
    const { instance } = service(repo);
    const result = await instance.apply({
      tenantId: TENANT_A,
      tenantSlug: 'cliente-a',
      clusters: singletonClusters([
        alertItem('fp-printer', 'printer-01'),
        alertItem('fp-ups', 'ups-02', '2026-09-05T12:00:20.000Z'),
      ]),
      hops: 4,
      windowMs: 300_000,
    });
    expect(result.clusters).toHaveLength(2);
    expect(result.suppressions).toBe(0);
    for (const enrichment of result.enrichments) {
      expect(enrichment.topologyEvidence.causalScore).toBeLessThan(0.3);
      expect(enrichment.topologyEvidence.topologyScore).toBeLessThan(0.5);
      expect(enrichment.suppression.applied).toBe(false);
    }
  });

  it('aísla tenants: el grafo de A no correlaciona claves de B', async () => {
    const { instance } = service(repo);
    const result = await instance.apply({
      tenantId: TENANT_B,
      tenantSlug: 'cliente-b',
      clusters: singletonClusters([
        alertItem('fp-srv', 'srv-01'),
        alertItem('fp-api', 'api-checkout'),
        alertItem('fp-app', 'app-checkout'),
        alertItem('fp-k8s', 'k8s-node-a'),
      ]),
      hops: 4,
      windowMs: 300_000,
    });
    expect(result.clusters).toHaveLength(4);
    expect(result.suppressions).toBe(0);
    expect(result.enrichments.every((item) => item.tenantId === TENANT_B)).toBe(
      true,
    );
    expect([...repo.queriedTenants]).toEqual([TENANT_B]);
  });

  it('publica ekumetrics.events.correlated con blastRadius/suppression/topologyEvidence', async () => {
    const { instance, eventBus } = service(repo);
    const applied = await instance.apply({
      tenantId: TENANT_A,
      tenantSlug: 'cliente-a',
      clusters: singletonClusters([
        alertItem('fp-srv', 'srv-01'),
        alertItem('fp-api', 'api-checkout'),
      ]),
      hops: 4,
      windowMs: 300_000,
    });
    await instance.publish({
      tenantId: TENANT_A,
      tenantSlug: 'cliente-a',
      clusterKey: 'cluster-1',
      incidentId: 'inc-1',
      siteId: SITE,
      enrichment: applied.enrichments[0],
    });
    expect(eventBus.publish).toHaveBeenCalledWith(
      EventSubjects.EVENTS_CORRELATED,
      expect.objectContaining({
        payload: expect.objectContaining({
          tenantId: TENANT_A,
          blastRadius: expect.anything(),
          suppression: expect.anything(),
          topologyEvidence: expect.objectContaining({ tenantId: TENANT_A }),
        }),
        headers: expect.objectContaining({ tenantId: TENANT_A }),
      }),
    );
  });

  it('no falla la correlación si el EventBus no está disponible', async () => {
    const { instance } = service(repo, {}, {
      publish: jest.fn().mockRejectedValue(new EventBusUnavailableError()),
    });
    const applied = await instance.apply({
      tenantId: TENANT_A,
      tenantSlug: 'cliente-a',
      clusters: [[alertItem('fp-api', 'api-checkout')]],
      hops: 4,
      windowMs: 300_000,
    });
    await expect(
      instance.publish({
        tenantId: TENANT_A,
        tenantSlug: 'cliente-a',
        clusterKey: 'cluster-1',
        enrichment: applied.enrichments[0],
      }),
    ).resolves.toBeUndefined();
  });
});

describe('CorrelationService + TopologyCorrelationService', () => {
  function alert(
    overrides: Partial<CorrelateAlert> & Pick<CorrelateAlert, 'fingerprint'>,
  ): CorrelateAlert {
    return {
      name: overrides.name ?? overrides.fingerprint,
      severity: overrides.severity ?? 'critical',
      siteId: overrides.siteId ?? SITE,
      nodeHint: overrides.nodeHint,
      startsAt: overrides.startsAt ?? '2026-09-05T12:00:00.000Z',
      labels: overrides.labels,
      fingerprint: overrides.fingerprint,
    };
  }

  it('extiende V2: un solo incidente de alta prioridad y evidencia conservada', async () => {
    const graphA = sw03Graph(TENANT_A);
    const repo = new FakeTopologyRepository(graphA.nodes, graphA.edges);
    const prisma = {
      tenant: { findUnique: jest.fn() },
      incident: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'inc-1', status: 'open', ...data }),
        ),
        update: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      agentEvent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const graph = {
      links: jest.fn().mockResolvedValue([]),
      matchNode: jest.fn(
        (_tenantId: string, _siteId: string | undefined, hint: string) =>
          Promise.resolve(hint ? { nodeKey: hint, name: hint } : null),
      ),
      nodeByKey: jest.fn((_tenantId: string, nodeKey: string) =>
        Promise.resolve(
          nodeKey ? { nodeKey, name: nodeKey === 'sw-03' ? 'Switch SW-03' : nodeKey } : null,
        ),
      ),
    };
    const topo = new TopologyCorrelationService(
      repo,
      configStub(),
      { publish: jest.fn().mockResolvedValue({ messageId: 'm1' }) } as never,
      new TopologyCorrelationMetrics(),
    );
    const corr = new CorrelationService(
      prisma as never,
      graph as never,
      { overview: jest.fn() } as never,
      configStub(),
      new CorrelationMetrics(),
      undefined,
      topo,
    );
    const result = await corr.merge(TENANT_A, 'cliente-a', [
      alert({ fingerprint: 'fp-sw', nodeHint: 'sw-03' }),
      alert({ fingerprint: 'fp-srv', nodeHint: 'srv-01' }),
      alert({ fingerprint: 'fp-k8s', nodeHint: 'k8s-node-a' }),
      alert({ fingerprint: 'fp-api', nodeHint: 'api-checkout' }),
      alert({ fingerprint: 'fp-app', nodeHint: 'app-checkout' }),
    ]);
    expect(result.created).toBe(1);
    const members = prisma.incident.create.mock.calls[0][0].data.members;
    expect(members.alerts).toHaveLength(5);
    expect(members.suppression.applied).toBe(true);
    expect(members.suppression.evidenceRetained).toBe(true);
    expect(members.blastRadius.originKey).toBe('sw-03');
    expect(members.topologyEvidence.tenantId).toBe(TENANT_A);
    expect(members.correlation.evidence).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Supresión de causa raíz'),
      ]),
    );
  });

  it('sin TopologyCorrelationService el clustering V2 no cambia', async () => {
    const prisma = {
      incident: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'inc-1', status: 'open', ...data }),
        ),
        count: jest.fn().mockResolvedValue(0),
      },
      agentEvent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const graph = {
      links: jest.fn().mockResolvedValue([]),
      matchNode: jest.fn(
        (_tenantId: string, _siteId: string | undefined, hint: string) =>
          Promise.resolve({ nodeKey: hint, name: hint }),
      ),
      nodeByKey: jest.fn((_tenantId: string, nodeKey: string) =>
        Promise.resolve({ nodeKey, name: nodeKey }),
      ),
    };
    const corr = new CorrelationService(
      prisma as never,
      graph as never,
      { overview: jest.fn() } as never,
      configStub(),
      new CorrelationMetrics(),
    );
    const result = await corr.merge(TENANT_A, 'cliente-a', [
      alert({ fingerprint: 'fp-a', nodeHint: 'printer-01' }),
      alert({ fingerprint: 'fp-b', nodeHint: 'ups-02' }),
    ]);
    expect(result.created).toBe(2);
    expect(prisma.incident.create.mock.calls[0][0].data.members.blastRadius).toBeUndefined();
  });
});

describe('TopologyCorrelationMetrics', () => {
  it('expone aiops_topology_correlations_total y aiops_root_cause_suppressions_total', () => {
    const metrics = new TopologyCorrelationMetrics();
    metrics.recordCorrelation(2);
    metrics.recordSuppression(3);
    const output = metrics.render();
    expect(output).toContain('# TYPE aiops_topology_correlations_total counter');
    expect(output).toContain('aiops_topology_correlations_total 2');
    expect(output).toContain(
      '# TYPE aiops_root_cause_suppressions_total counter',
    );
    expect(output).toContain('aiops_root_cause_suppressions_total 3');
  });
});
