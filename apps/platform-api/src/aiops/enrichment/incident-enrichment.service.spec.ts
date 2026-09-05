jest.mock('../../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { TenantScopeError } from '../persistence/tenant-scope.error';
import { IncidentEnrichmentMetrics } from './incident-enrichment.metrics';
import { InMemoryIncidentEnrichmentRepository } from './incident-enrichment.repository';
import { IncidentEnrichmentService } from './incident-enrichment.service';
import { IncidentPriorityCalculator } from './incident-priority.calculator';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function incidentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inc-1',
    tenantId: TENANT_A,
    title: 'Degradacion · Core switch',
    status: 'open',
    severity: 'critical',
    siteId: 'santiago',
    clusterKey: 'cluster-1',
    causeKey: 'sw-core',
    causeName: 'Core switch',
    confidence: 0.85,
    windowStart: new Date('2026-09-05T10:31:00.000Z'),
    windowEnd: new Date('2026-09-05T10:32:00.000Z'),
    members: {
      alerts: [
        {
          fingerprint: 'fp-db',
          name: 'DB latency',
          severity: 'critical',
          nodeHint: 'postgres',
          startsAt: '2026-09-05T10:31:02.000Z',
        },
        {
          fingerprint: 'fp-pool',
          name: 'connection pool saturation',
          severity: 'error',
          nodeHint: 'postgres',
          startsAt: '2026-09-05T10:31:15.000Z',
        },
        {
          fingerprint: 'fp-api',
          name: 'API latency',
          severity: 'warning',
          nodeHint: 'api-pagos',
          startsAt: '2026-09-05T10:31:36.000Z',
        },
        {
          fingerprint: 'fp-5xx',
          name: 'HTTP 5xx',
          severity: 'critical',
          nodeHint: 'api-pagos',
          startsAt: '2026-09-05T10:31:41.000Z',
        },
        {
          fingerprint: 'fp-pod',
          name: 'pod timeout',
          severity: 'error',
          nodeHint: 'checkout-pod',
          startsAt: '2026-09-05T10:31:55.000Z',
        },
      ],
      impact: ['api-pagos', 'postgres', 'checkout-pod'],
      correlation: {
        score: 0.72,
        evidence: ['ventana temporal 53 segundos'],
        details: [
          {
            kind: 'temporal',
            statement: 'ventana temporal 53 segundos',
            score: 0.8,
          },
        ],
      },
      collectorEvents: [
        {
          fingerprint: 'fp-db',
          signal: 'metric.anomaly',
          assetKey: 'postgres',
        },
      ],
    },
    createdAt: new Date('2026-09-05T10:31:00.000Z'),
    updatedAt: new Date('2026-09-05T10:32:00.000Z'),
    ...overrides,
  };
}

describe('IncidentEnrichmentService', () => {
  const prisma = {
    incident: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    agentEvent: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    policy: {
      findFirst: jest.fn(),
    },
  };
  const graph = {
    impact: jest.fn(),
    listNodes: jest.fn(),
  };
  let store: InMemoryIncidentEnrichmentRepository;
  const metrics = new IncidentEnrichmentMetrics();

  const service = () =>
    new IncidentEnrichmentService(
      prisma as never,
      graph as never,
      store,
      new IncidentPriorityCalculator(),
      metrics,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    store = new InMemoryIncidentEnrichmentRepository();
    prisma.incident.findFirst.mockResolvedValue(incidentRow());
    prisma.incident.findMany.mockResolvedValue([
      {
        id: 'inc-old',
        title: 'Incidente previo',
        causeKey: 'sw-core',
        clusterKey: 'cluster-1',
        status: 'resolved',
      },
    ]);
    prisma.agentEvent.findMany.mockResolvedValue([
      {
        fingerprint: 'chg-1',
        signal: 'deploy.observed',
        category: 'deploy',
        assetKey: 'api-pagos',
        eventAt: new Date('2026-09-05T10:30:50.000Z'),
      },
    ]);
    prisma.agentEvent.findFirst.mockResolvedValue({ environment: 'prod' });
    prisma.policy.findFirst.mockResolvedValue(null);
    graph.impact.mockResolvedValue({
      hops: 3,
      nodes: [
        { key: 'sw-core', name: 'Core switch', kind: 'switch' },
        { key: 'api-pagos', name: 'API pagos', kind: 'service' },
        { key: 'postgres', name: 'Postgres', kind: 'database' },
      ],
      edges: [
        { from: 'api-pagos', to: 'sw-core' },
        { from: 'postgres', to: 'sw-core' },
      ],
    });
    graph.listNodes.mockResolvedValue([
      { nodeKey: 'checkout-pod', name: 'checkout', kind: 'pod', siteId: 'santiago' },
    ]);
  });

  it('construye el payload de enriquecimiento explicable', async () => {
    const result = await service().enrich(TENANT_A, 'inc-1');
    expect(result).not.toBeNull();
    expect(result?.tenantId).toBe(TENANT_A);
    expect(result?.incidentId).toBe('inc-1');
    expect(result?.algorithm).toBe('deterministic_enrichment_v1');
    expect(result?.source).toBe('aiops.enrichment');
    expect(result?.score).toBeGreaterThan(0);
    expect(result?.confidence).toBeGreaterThan(0);
    expect(result?.evidence.length).toBeGreaterThan(0);
    expect(result?.affectedEntities.map((item) => item.entityKey)).toEqual(
      expect.arrayContaining(['sw-core', 'api-pagos', 'postgres']),
    );
    expect(result?.affectedServices.some((item) => item.kind === 'database')).toBe(
      true,
    );
    expect(result?.blastRadius.originKey).toBe('sw-core');
    expect(result?.blastRadius.entityCount).toBeGreaterThan(1);
    expect(result?.anomalies.length).toBeGreaterThan(0);
    expect(result?.primaryRootCause?.entityKey).toBe('sw-core');
    expect(result?.rcaConfidence).toBe(0.85);
    expect(result?.rootCauseCandidates.length).toBeGreaterThan(1);
    expect(result?.correlationEvidence[0]?.statement).toContain('ventana temporal');
    expect(result?.recentChanges[0]?.source).toBe('agent_event');
    expect(result?.historicalMatches[0]?.incidentId).toBe('inc-old');
    expect(result?.computedPriority.factors.map((item) => item.id)).toEqual(
      expect.arrayContaining(['severity', 'blastRadius', 'environment']),
    );
    expect(result?.timeline.map((item) => item.sequence)[0]).toBe(1);
    const clock = result?.timeline.map((item) => item.summary) ?? [];
    expect(clock.indexOf('DB latency anomaly')).toBeLessThan(
      clock.indexOf('connection pool saturation'),
    );
  });

  it('consulta historial, grafo y eventos solo del tenant del incidente', async () => {
    await service().enrich(TENANT_A, 'inc-1');
    expect(prisma.incident.findFirst).toHaveBeenCalledWith({
      where: { id: 'inc-1', tenantId: TENANT_A },
    });
    expect(graph.impact).toHaveBeenCalledWith(TENANT_A, 'sw-core');
    expect(prisma.incident.findMany.mock.calls[0][0].where.tenantId).toBe(
      TENANT_A,
    );
    expect(prisma.agentEvent.findMany.mock.calls[0][0].where.tenantId).toBe(
      TENANT_A,
    );
  });

  it('no enriquece un incidente de otro tenant', async () => {
    prisma.incident.findFirst.mockResolvedValue(null);
    const result = await service().enrich(TENANT_B, 'inc-1');
    expect(result).toBeNull();
    expect(await store.findByIncident(TENANT_B, 'inc-1')).toBeNull();
  });

  it('attachMany no cruza tenants', async () => {
    await service().enrich(TENANT_A, 'inc-1');
    const rows = await service().attachMany(TENANT_B, [
      { id: 'inc-1', tenantId: TENANT_B, title: 'x' },
    ]);
    expect(rows[0].enrichment).toBeNull();
    const own = await service().attachMany(TENANT_A, [
      { id: 'inc-1', tenantId: TENANT_A, title: 'x' },
    ]);
    expect(own[0].enrichment?.incidentId).toBe('inc-1');
  });

  it('exige tenantId', async () => {
    await expect(service().enrich('', 'inc-1')).rejects.toBeInstanceOf(
      TenantScopeError,
    );
  });

  it('aplica feedback RCA confirm/reject sobre el store in-module', async () => {
    await service().enrich(TENANT_A, 'inc-1');
    const confirmed = await service().applyRcaFeedback(TENANT_A, 'inc-1', {
      action: 'confirm',
      actor: 'ops@cliente',
    });
    expect(confirmed.primaryRootCause?.status).toBe('ACCEPTED');
    const rejected = await service().applyRcaFeedback(TENANT_A, 'inc-1', {
      action: 'reject',
      candidateId: confirmed.primaryRootCause?.id,
      actor: 'ops@cliente',
    });
    expect(
      rejected.rootCauseCandidates.find((item) => item.rank === 1)?.status,
    ).toBe('REJECTED');
  });

  it('aplica rca.completed sin un segundo algoritmo de RCA', async () => {
    await service().enrich(TENANT_A, 'inc-1');
    const first = await service().applyRcaCompleted(TENANT_A, 'inc-1', {
      tenantId: TENANT_A,
      incidentId: 'inc-1',
      algorithm: 'weighted_subscores_v1',
      durationMs: 12,
      leadingScore: 0.9,
      leadingConfidence: 0.88,
      candidates: [
        {
          entityId: 'postgres',
          entityKey: 'postgres',
          entityType: 'database',
          rank: 1,
          score: 0.9,
          confidence: 0.88,
          hypothesis: 'PostgreSQL es el candidato principal.',
          algorithm: 'weighted_subscores_v1',
          source: 'deterministic_rca',
          evidence: [
            {
              kind: 'metric',
              summary: 'anomalía de latency',
              confidence: 0.9,
              entityKey: 'postgres',
              facts: {},
            },
          ],
          affectedEntities: ['api-pagos'],
          affectedServices: ['api-pagos'],
          subscores: {
            temporalScore: 0.7,
            topologyScore: 0.8,
            anomalyScore: 0.9,
            dependencyScore: 0.7,
            historicalScore: 0.5,
          },
          weights: {
            temporal: 0.2,
            topology: 0.25,
            anomaly: 0.2,
            dependency: 0.25,
            historical: 0.1,
          },
        },
      ],
    });
    expect(first?.rcaMode).toBe('deterministic_engine');
    expect(first?.primaryRootCause?.algorithm).toBe('weighted_subscores_v1');
    const second = await service().applyRcaCompleted(TENANT_A, 'inc-1', {
      tenantId: TENANT_A,
      incidentId: 'inc-1',
      algorithm: 'weighted_subscores_v1',
      durationMs: 12,
      leadingScore: 0.9,
      leadingConfidence: 0.88,
      candidates: first!.rootCauseCandidates.map((item) => ({
        entityId: item.entityKey ?? '',
        entityKey: item.entityKey,
        rank: item.rank,
        score: item.score,
        confidence: item.confidence,
        hypothesis: item.hypothesis,
        algorithm: item.algorithm,
        source: item.source,
        evidence: [],
        affectedEntities: [],
        affectedServices: [],
        subscores: {
          temporalScore: 0,
          topologyScore: 0,
          anomalyScore: 0,
          dependencyScore: 0,
          historicalScore: 0,
        },
        weights: {
          temporal: 0.2,
          topology: 0.25,
          anomaly: 0.2,
          dependency: 0.25,
          historical: 0.1,
        },
      })),
    });
    expect(second?.rootCauseCandidates).toHaveLength(1);
    expect(metrics.render()).toContain('aiops_rca_results_persisted_total 2');
  });
});
