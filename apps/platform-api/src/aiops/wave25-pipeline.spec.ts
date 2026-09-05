jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { InMemoryEventBus } from '../messaging/in-memory.event-bus';
import { InMemoryIdempotencyStore } from '../messaging/idempotency';
import { EventSubjects, buildHeaders } from '../messaging';
import { DegradedEventBus } from '../messaging/degraded.event-bus';
import { AnomalyEngine } from './anomaly/anomaly.engine';
import { AnomalyMetrics } from './anomaly/anomaly-metrics';
import { InMemoryAnomalyPolicyRepository } from './anomaly/anomaly-policy.repository';
import { InMemoryAnomalyRepository } from './anomaly/anomaly.repository';
import { PrismaAnomalyRepository } from './anomaly/prisma-anomaly.repository';
import { AnomalyWorker } from './anomaly/anomaly.worker';
import { EWMADetector } from './anomaly/detectors/ewma.detector';
import { RobustZScoreDetector } from './anomaly/detectors/robust-zscore.detector';
import { RollingBaselineDetector } from './anomaly/detectors/rolling-baseline.detector';
import { StaticThresholdDetector } from './anomaly/detectors/static-threshold.detector';
import { MetricWindowStore } from './anomaly/metric-window.store';
import { InMemoryPlatformThresholdSource } from './anomaly/platform-threshold.source';
import { createAnomalyResult } from './anomaly/anomaly-result';
import { IncidentEnrichmentService } from './enrichment/incident-enrichment.service';
import { InMemoryIncidentEnrichmentRepository } from './enrichment/incident-enrichment.repository';
import { PrismaIncidentEnrichmentRepository } from './enrichment/prisma-incident-enrichment.repository';
import { IncidentPriorityCalculator } from './enrichment/incident-priority.calculator';
import { IncidentEnrichmentMetrics } from './enrichment/incident-enrichment.metrics';
import { IncidentEnrichmentWorker } from './enrichment/incident-enrichment.worker';
import { IncidentEnrichmentPublisher } from './enrichment/incident-enrichment.publisher';
import { HistoricalService } from './historical/historical.service';
import { InMemoryHistoricalRepository } from './historical/in-memory.historical.repository';
import { PrismaHistoricalRepository } from './historical/prisma-historical.repository';
import { RepositoryAnomalyEvidenceAdapter } from './rca/repository-anomaly-evidence.adapter';
import { HistoricalServiceEvidenceAdapter } from './rca/historical-service-evidence.adapter';
import { NeutralHistoricalEvidenceAdapter } from './rca/historical-evidence.port';
import { RcaEventSubscriber } from './rca/subscriber';
import { IncidentRcaCompletedSubscriber } from './enrichment/incident-rca-completed.subscriber';
import { parseRcaFeedbackAction } from './contracts/rca-feedback';

const TENANT = 'tenant-a';
const OTHER = 'tenant-b';

function createFakePrisma() {
  const anomalies = new Map<string, Record<string, unknown>>();
  const enrichments = new Map<string, Record<string, unknown>>();
  const signatures = new Map<string, Record<string, unknown>>();
  const resolutions = new Map<string, Record<string, unknown>>();
  const feedback: Record<string, unknown>[] = [];
  const incidents = new Map<string, Record<string, unknown>>([
    [
      'inc-1',
      {
        id: 'inc-1',
        tenantId: TENANT,
        title: 'Checkout latency',
        status: 'open',
        severity: 'critical',
        siteId: 'prod',
        clusterKey: 'cluster-1',
        causeKey: 'postgres.prod',
        causeName: 'PostgreSQL PROD',
        confidence: 0.7,
        windowStart: new Date('2026-09-05T10:00:00Z'),
        windowEnd: new Date('2026-09-05T10:10:00Z'),
        members: {
          alerts: [
            {
              fingerprint: 'fp-1',
              name: 'DB latency',
              severity: 'critical',
              nodeHint: 'postgres.prod',
              startsAt: '2026-09-05T10:00:00Z',
            },
          ],
          impact: ['api-pagos', 'postgres.prod'],
          collectorEvents: [],
        },
        createdAt: new Date('2026-09-05T10:00:00Z'),
        updatedAt: new Date('2026-09-05T10:00:00Z'),
      },
    ],
  ]);

  return {
    anomalies,
    enrichments,
    signatures,
    resolutions,
    feedback,
    incidents,
    incident: {
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; tenantId: string } }) => {
          const row = incidents.get(where.id);
          if (!row || row.tenantId !== where.tenantId) return null;
          return row;
        },
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    agentEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ environment: 'prod' }),
    },
    policy: { findFirst: jest.fn().mockResolvedValue(null) },
    aiopsAnomaly: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        anomalies.get(where.id) ?? null,
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
        }: {
          where: { id: string };
          create: Record<string, unknown>;
        }) => {
          const row = { ...create, id: where.id };
          anomalies.set(where.id, row);
          return row;
        },
      ),
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: { tenantId: string; entityId?: { in: string[] } };
        }) =>
          [...anomalies.values()].filter((row) => {
            if (row.tenantId !== where.tenantId) return false;
            if (where.entityId?.in && !where.entityId.in.includes(String(row.entityId))) {
              return false;
            }
            return true;
          }),
      ),
    },
    incidentEnrichment: {
      findUnique: jest.fn(
        async ({ where }: { where: { incidentId: string } }) =>
          enrichments.get(where.incidentId) ?? null,
      ),
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { tenantId: string; incidentId: string };
        }) => {
          const row = enrichments.get(where.incidentId);
          if (!row || row.tenantId !== where.tenantId) return null;
          return row;
        },
      ),
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: { tenantId: string; incidentId?: { in: string[] } };
        }) =>
          [...enrichments.values()].filter((row) => row.tenantId === where.tenantId),
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `enr-${data.incidentId}` };
        enrichments.set(String(data.incidentId), row);
        return row;
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const current = [...enrichments.values()].find((row) => row.id === where.id);
          if (!current) return data;
          const next = { ...current, ...data };
          enrichments.set(String(next.incidentId), next);
          return next;
        },
      ),
    },
    incidentSignature: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { tenantId_hash: { tenantId: string; hash: string } };
        }) =>
          signatures.get(
            `${where.tenantId_hash.tenantId}:${where.tenantId_hash.hash}`,
          ) ?? null,
      ),
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { tenantId: string; incidentIds?: { has: string } };
        }) =>
          [...signatures.values()].find((row) => {
            if (row.tenantId !== where.tenantId) return false;
            if (where.incidentIds?.has) {
              return (row.incidentIds as string[]).includes(where.incidentIds.has);
            }
            return true;
          }) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: { tenantId: string } }) =>
        [...signatures.values()].filter((row) => row.tenantId === where.tenantId),
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          ...data,
          id: `sig-${data.hash}`,
          version: 'v1',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        signatures.set(`${data.tenantId}:${data.hash}`, row);
        return row;
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const current = [...signatures.values()].find((row) => row.id === where.id);
          const next = { ...current, ...data, updatedAt: new Date() };
          signatures.set(`${next.tenantId}:${next.hash}`, next);
          return next;
        },
      ),
    },
    resolutionRecord: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          ...data,
          id: `res-${data.incidentId}`,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        resolutions.set(`${data.tenantId}:${data.incidentId}`, row);
        return row;
      }),
      update: jest.fn(),
    },
    rcaFeedback: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          ...data,
          id: `fb-${feedback.length + 1}`,
          createdAt: new Date(),
        };
        feedback.push(row);
        return row;
      }),
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: { tenantId: string; incidentId: string };
        }) =>
          feedback.filter(
            (row) =>
              row.tenantId === where.tenantId &&
              row.incidentId === where.incidentId,
          ),
      ),
    },
    rcaScoringPolicy: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

describe('Wave 2.5 product pipeline', () => {
  it('normaliza aliases de feedback al enum canónico', () => {
    expect(parseRcaFeedbackAction('confirm')).toBe('CONFIRM');
    expect(parseRcaFeedbackAction('add_note')).toBe('ADD_NOTE');
  });

  it('1-3: events.ingested alimenta AnomalyWorker y persiste en el adaptador Prisma', async () => {
    const bus = new InMemoryEventBus(new InMemoryIdempotencyStore());
    const fake = createFakePrisma();
    const repo = new PrismaAnomalyRepository(fake as never);
    const engine = new AnomalyEngine(
      [
        new StaticThresholdDetector(),
        new RollingBaselineDetector(),
        new RobustZScoreDetector(),
        new EWMADetector(),
      ],
      new InMemoryAnomalyPolicyRepository(),
      new InMemoryPlatformThresholdSource(),
      repo,
      new MetricWindowStore(),
      new AnomalyMetrics(),
      bus,
    );
    const worker = new AnomalyWorker(bus, engine);
    await worker.onModuleInit();
    const now = Date.now();
    const samples = Array.from({ length: 40 }, (_, index) => ({
      tenantId: TENANT,
      entityId: 'postgres.prod',
      metricName: 'db_latency_ms',
      value: index === 39 ? 200 : 10,
      timestamp: now - (39 - index) * 60_000,
    }));
    await bus.publish(EventSubjects.EVENTS_INGESTED, {
      payload: { tenantId: TENANT, samples },
      headers: buildHeaders({
        tenantId: TENANT,
        correlationId: 'corr-ingest',
      }),
      idempotencyKey: `${TENANT}:events.ingested:e1`,
    });
    expect(fake.anomalies.size).toBeGreaterThan(0);
    const replica = new PrismaAnomalyRepository(fake as never);
    const rows = await replica.findForEntities(TENANT, ['postgres.prod']);
    expect(rows.every((row) => row.tenantId === TENANT)).toBe(true);
    expect(await replica.findForEntities(OTHER, ['postgres.prod'])).toEqual([]);
    await worker.onModuleDestroy();
    await bus.close();
  });

  it('12: redelivery con la misma idempotencyKey no duplica resultados RCA', async () => {
    const fake = createFakePrisma();
    const graph = {
      impact: jest.fn().mockResolvedValue({ hops: 1, nodes: [], edges: [] }),
      listNodes: jest.fn().mockResolvedValue([]),
    };
    const store = new InMemoryIncidentEnrichmentRepository();
    const enrichment = new IncidentEnrichmentService(
      fake as never,
      graph as never,
      store,
      new IncidentPriorityCalculator(),
      new IncidentEnrichmentMetrics(),
    );
    await enrichment.enrich(TENANT, 'inc-1');
    const bus = new InMemoryEventBus(new InMemoryIdempotencyStore());
    const subscriber = new IncidentRcaCompletedSubscriber(bus, enrichment);
    await subscriber.onModuleInit();
    const payload = {
      tenantId: TENANT,
      incidentId: 'inc-1',
      algorithm: 'weighted_subscores_v1',
      durationMs: 5,
      leadingConfidence: 0.8,
      candidates: [
        {
          entityId: 'postgres.prod',
          entityKey: 'postgres.prod',
          rank: 1,
          score: 0.8,
          confidence: 0.8,
          hypothesis: 'candidato único',
          algorithm: 'weighted_subscores_v1',
          source: 'deterministic_rca',
          evidence: [
            {
              kind: 'metric',
              summary: 'anomalía',
              confidence: 0.8,
              facts: {},
            },
          ],
          affectedEntities: [],
          affectedServices: [],
          subscores: {
            temporalScore: 0.5,
            topologyScore: 0.5,
            anomalyScore: 0.8,
            dependencyScore: 0.5,
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
    };
    const message = {
      payload,
      headers: buildHeaders({
        tenantId: TENANT,
        incidentId: 'inc-1',
        correlationId: 'rca-dup',
        producedBy: 'test',
      }),
      idempotencyKey: `${TENANT}:rca.completed:inc-1:rca-dup`,
    };
    await bus.publish(EventSubjects.RCA_COMPLETED, message);
    await bus.publish(EventSubjects.RCA_COMPLETED, message);
    const snapshot = await enrichment.find(TENANT, 'inc-1');
    expect(snapshot?.rootCauseCandidates).toHaveLength(1);
    await subscriber.onModuleDestroy();
    await bus.close();
  });

  it('11-12: dos réplicas Prisma ven el mismo estado y el upsert es idempotente', async () => {
    const fake = createFakePrisma();
    const a = new PrismaAnomalyRepository(fake as never);
    const b = new PrismaAnomalyRepository(fake as never);
    const result = createAnomalyResult({
      tenantId: TENANT,
      entityId: 'postgres.prod',
      metricName: 'db_latency_ms',
      timestamp: '2026-09-05T10:00:00.000Z',
      actualValue: 200,
      expectedValue: 10,
      score: 0.9,
      confidence: 0.8,
      algorithm: 'robust_zscore',
      window: '5m',
      metadata: {
        evidence: [{ summary: 'spike', facts: { z: 6 } }],
        source: 'robust_zscore',
        sampleCount: 40,
      },
    });
    await a.save(TENANT, result);
    await a.save(TENANT, result);
    const seen = await b.findForEntities(TENANT, ['postgres.prod']);
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe(result.id);
  });

  it('8-10: feedback y enrichment Prisma sobreviven un "reinicio" (nueva instancia)', async () => {
    const fake = createFakePrisma();
    const histA = new PrismaHistoricalRepository(fake as never);
    await histA.createFeedback({
      tenantId: TENANT,
      incidentId: 'inc-1',
      action: 'CONFIRM',
      selectedEntityId: 'postgres.prod',
      note: 'confirmado',
    });
    const histB = new PrismaHistoricalRepository(fake as never);
    const listed = await histB.listFeedback(TENANT, 'inc-1');
    expect(listed).toHaveLength(1);
    expect(listed[0].action).toBe('CONFIRM');
    expect(await histB.listFeedback(OTHER, 'inc-1')).toEqual([]);

    const graph = {
      impact: jest.fn().mockResolvedValue({ hops: 2, nodes: [], edges: [] }),
      listNodes: jest.fn().mockResolvedValue([]),
    };
    const enrichA = new IncidentEnrichmentService(
      fake as never,
      graph as never,
      new PrismaIncidentEnrichmentRepository(fake as never),
      new IncidentPriorityCalculator(),
      new IncidentEnrichmentMetrics(),
    );
    const snapshot = await enrichA.enrich(TENANT, 'inc-1');
    expect(snapshot?.incidentId).toBe('inc-1');
    const enrichB = new IncidentEnrichmentService(
      fake as never,
      graph as never,
      new PrismaIncidentEnrichmentRepository(fake as never),
      new IncidentPriorityCalculator(),
      new IncidentEnrichmentMetrics(),
    );
    const reloaded = await enrichB.find(TENANT, 'inc-1');
    expect(reloaded?.incidentId).toBe('inc-1');
    expect(await enrichB.find(OTHER, 'inc-1')).toBeNull();
  });

  it('4-7 + e2e: incident enrichment publica rca.requested, RCA lee anomalía/histórico y rca.completed actualiza el snapshot', async () => {
    const bus = new InMemoryEventBus(new InMemoryIdempotencyStore());
    const anomalies = new InMemoryAnomalyRepository();
    await anomalies.save(
      TENANT,
      createAnomalyResult({
        tenantId: TENANT,
        entityId: 'postgres.prod',
        metricName: 'db_latency_ms',
        timestamp: '2026-09-05T10:00:00.000Z',
        actualValue: 210,
        expectedValue: 12,
        score: 0.94,
        confidence: 0.9,
        algorithm: 'robust_zscore',
        window: '5m',
        metadata: {
          evidence: [{ summary: 'latency spike', facts: { z: 5.2 } }],
          source: 'robust_zscore',
          sampleCount: 24,
          entityType: 'database',
        },
      }),
    );
    const historicalStore = new InMemoryHistoricalRepository();
    const historical = new HistoricalService(historicalStore);
    await historical.recordSignature(
      TENANT,
      {
        tenantId: TENANT,
        incidentId: 'inc-old',
        entityTypes: ['database'],
        service: 'checkout',
        eventTypes: ['DB latency'],
        anomalyTypes: ['latency'],
        topologyPattern: 'postgres.prod',
        environment: 'prod',
        proposedRootCause: 'postgres.prod',
      },
      'inc-old',
    );
    await historical.recordFeedback({
      tenantId: TENANT,
      incidentId: 'inc-old',
      action: 'CONFIRM',
      confirmedRootCause: 'postgres.prod',
      signature: {
        tenantId: TENANT,
        entityTypes: ['database'],
        service: 'checkout',
        eventTypes: ['DB latency'],
        anomalyTypes: ['latency'],
        topologyPattern: 'postgres.prod',
        environment: 'prod',
      },
    });

    const prisma = createFakePrisma();
    const graph = {
      impact: jest.fn().mockResolvedValue({
        hops: 2,
        nodes: [
          { key: 'postgres.prod', name: 'PostgreSQL PROD', kind: 'database' },
          { key: 'api-pagos', name: 'API pagos', kind: 'service' },
        ],
        edges: [{ from: 'api-pagos', to: 'postgres.prod' }],
      }),
      listNodes: jest.fn().mockResolvedValue([]),
    };
    const enrichmentStore = new InMemoryIncidentEnrichmentRepository();
    const enrichment = new IncidentEnrichmentService(
      prisma as never,
      graph as never,
      enrichmentStore,
      new IncidentPriorityCalculator(),
      new IncidentEnrichmentMetrics(),
      undefined,
      anomalies,
      historical,
    );
    const publisher = new IncidentEnrichmentPublisher(bus);
    const worker = new IncidentEnrichmentWorker(bus, enrichment, publisher);
    const rcaCompleted = new IncidentRcaCompletedSubscriber(bus, enrichment);
    const anomalyPort = new RepositoryAnomalyEvidenceAdapter(anomalies);
    const historicalPort = new HistoricalServiceEvidenceAdapter(historical);
    const engine = {
      propose: async (input: { tenantId: string; incidentId: string }) => {
        const found = await anomalyPort.findForIncident({
          tenantId: input.tenantId,
          incidentId: input.incidentId,
          entityKeys: ['postgres.prod', 'api-pagos'],
        });
        const hist = await historicalPort.lookup({
          tenantId: input.tenantId,
          incidentId: input.incidentId,
          entityId: 'postgres.prod',
        });
        expect(found.length).toBeGreaterThan(0);
        expect(found[0].metric).toBe('db_latency_ms');
        expect(hist.available || hist.score === 0.5).toBe(true);
        return [
          {
            tenantId: input.tenantId,
            incidentId: input.incidentId,
            rank: 1,
            entityKey: 'postgres.prod',
            entityType: 'database',
            hypothesis:
              'PostgreSQL PROD es el candidato principal porque anomalía de latency 0.94.',
            score: 0.88,
            confidence: 0.91,
            evidence: [
              {
                kind: 'metric',
                summary: 'anomalía de latency score 0.94',
                confidence: 0.94,
                entityKey: 'postgres.prod',
                facts: {},
              },
            ],
            source: 'deterministic_rca',
            algorithm: 'weighted_subscores_v1',
            findingIds: [],
            affectedEntities: ['api-pagos'],
            affectedServices: ['api-pagos'],
            subscores: {
              temporalScore: 0.7,
              topologyScore: 0.8,
              anomalyScore: 0.94,
              dependencyScore: 0.7,
              historicalScore: hist.score,
            },
            weights: {
              temporal: 0.2,
              topology: 0.25,
              anomaly: 0.2,
              dependency: 0.25,
              historical: 0.1,
            },
          },
        ];
      },
    };
    const rcaSub = new RcaEventSubscriber(bus, engine as never);
    await worker.onModuleInit();
    await rcaCompleted.onModuleInit();
    await rcaSub.onModuleInit();

    await bus.publish(EventSubjects.INCIDENTS_ENRICHMENT_REQUESTED, {
      payload: { tenantId: TENANT, incidentId: 'inc-1' },
      headers: buildHeaders({
        tenantId: TENANT,
        incidentId: 'inc-1',
        correlationId: 'enr-1',
      }),
      idempotencyKey: `${TENANT}:incidents.enrichment.requested:inc-1`,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    const snapshot = await enrichment.find(TENANT, 'inc-1');
    expect(snapshot).toBeTruthy();
    expect(snapshot?.anomalies.some((item) => item.entityKey === 'postgres.prod')).toBe(
      true,
    );
    expect(snapshot?.rcaMode).toBe('deterministic_engine');
    expect(snapshot?.primaryRootCause?.algorithm).toBe('weighted_subscores_v1');
    expect(snapshot?.aiInvestigationStatus).toBe('not_executed');

    await worker.onModuleDestroy();
    await rcaCompleted.onModuleDestroy();
    await rcaSub.onModuleDestroy();
    await bus.close();
  });

  it('13: RCA no cruza tenants en evidencia de anomalía', async () => {
    const repo = new InMemoryAnomalyRepository();
    await repo.save(
      TENANT,
      createAnomalyResult({
        tenantId: TENANT,
        entityId: 'postgres.prod',
        metricName: 'db_latency_ms',
        timestamp: '2026-09-05T10:00:00.000Z',
        actualValue: 1,
        expectedValue: 1,
        score: 0.9,
        confidence: 0.9,
        algorithm: 'ewma',
        window: '5m',
        metadata: {
          evidence: [{ summary: 'x', facts: {} }],
          source: 'ewma',
          sampleCount: 8,
        },
      }),
    );
    const port = new RepositoryAnomalyEvidenceAdapter(repo);
    const leaked = await port.findForIncident({
      tenantId: OTHER,
      incidentId: 'inc-x',
      entityKeys: ['postgres.prod'],
    });
    expect(leaked).toEqual([]);
  });

  it('14: NATS degradado no rompe APIs de incidente (enrichment request se omite)', async () => {
    const publisher = new IncidentEnrichmentPublisher(new DegradedEventBus());
    await expect(
      publisher.request({ id: 'inc-1', tenantId: TENANT }),
    ).resolves.toBeUndefined();
    const store = new InMemoryIncidentEnrichmentRepository();
    await store.save({
      tenantId: TENANT,
      incidentId: 'inc-1',
      schemaVersion: 1,
      algorithm: 'deterministic_enrichment_v1',
      source: 'aiops.enrichment',
      score: 0.5,
      confidence: 0.5,
      evidence: [
        {
          kind: 'enrichment',
          statement: 'ok',
          score: 0.5,
          confidence: 0.5,
          algorithm: 'deterministic_enrichment_v1',
          source: 'aiops.enrichment',
        },
      ],
      computedPriority: {
        level: 'P3',
        score: 0.4,
        confidence: 0.4,
        algorithm: 'weighted_priority_v1',
        source: 'test',
        evidence: [],
        factors: [],
      },
      affectedEntities: [],
      affectedServices: [],
      blastRadius: {
        originKey: null,
        hops: 0,
        entityCount: 0,
        entityKeys: [],
        score: 0,
        confidence: 0,
        algorithm: 'none',
        source: 'test',
        evidence: [],
      },
      topologyEvidence: [],
      anomalies: [],
      rootCauseCandidates: [],
      primaryRootCause: null,
      rcaConfidence: null,
      correlationEvidence: [],
      timeline: [],
      recentChanges: [],
      historicalMatches: [],
      operatorFeedback: [],
      rcaMode: 'correlation_fallback',
      aiInvestigationStatus: 'not_executed',
      enrichedAt: new Date().toISOString(),
    });
    expect((await store.findByIncident(TENANT, 'inc-1'))?.incidentId).toBe(
      'inc-1',
    );
  });

  it('histórico neutro cuando HistoricalService no tiene firma', async () => {
    const adapter = new HistoricalServiceEvidenceAdapter(
      new HistoricalService(new InMemoryHistoricalRepository()),
    );
    const evidence = await adapter.lookup({
      tenantId: TENANT,
      incidentId: 'missing',
      entityId: 'x',
    });
    expect(evidence.available).toBe(false);
    expect(evidence.score).toBe(0.5);
  });

  it('NeutralHistoricalEvidenceAdapter permanece disponible para tests unitarios', async () => {
    const evidence = await new NeutralHistoricalEvidenceAdapter().lookup({
      tenantId: TENANT,
      incidentId: 'inc-1',
      entityId: 'x',
    });
    expect(evidence.available).toBe(false);
    expect(evidence.score).toBe(0.5);
  });
});
