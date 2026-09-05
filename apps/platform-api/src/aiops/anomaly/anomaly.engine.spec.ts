jest.mock('../../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { InMemoryEventBus } from '../../messaging/in-memory.event-bus';
import { InMemoryIdempotencyStore } from '../../messaging/idempotency';
import { EventSubjects, buildHeaders, type EventBus } from '../../messaging';
import { AnomalyEngine } from './anomaly.engine';
import { AnomalyMetrics } from './anomaly-metrics';
import { InMemoryAnomalyPolicyRepository } from './anomaly-policy.repository';
import { InMemoryAnomalyRepository } from './anomaly.repository';
import type { AnomaliesDetectedPayload, AnomalyResult } from './anomaly-result';
import { AnomalyWorker } from './anomaly.worker';
import { EWMADetector } from './detectors/ewma.detector';
import { RobustZScoreDetector } from './detectors/robust-zscore.detector';
import { RollingBaselineDetector } from './detectors/rolling-baseline.detector';
import { StaticThresholdDetector } from './detectors/static-threshold.detector';
import {
  ChangePointDetectorStub,
  IsolationForestDetectorStub,
  SeasonalBaselineDetectorStub,
} from './detectors/advanced-stubs';
import type { MetricSample } from './metric-sample';
import { MetricWindowStore } from './metric-window.store';
import { InMemoryPlatformThresholdSource } from './platform-threshold.source';

const STEP_MS = 60_000;

function samples(input: {
  tenantId: string;
  entityId?: string;
  metricName?: string;
  count: number;
  value: (index: number) => number;
  now: number;
  siteId?: string;
}): MetricSample[] {
  const entityId = input.entityId ?? 'host-1';
  const metricName = input.metricName ?? 'cpu_used_ratio';
  const start = input.now - (input.count - 1) * STEP_MS;
  return Array.from({ length: input.count }, (_, index) => ({
    tenantId: input.tenantId,
    entityId,
    metricName,
    value: input.value(index),
    timestamp: start + index * STEP_MS,
    siteId: input.siteId,
  }));
}

function createHarness(bus?: EventBus) {
  const store = new MetricWindowStore();
  const repo = new InMemoryAnomalyRepository();
  const policies = new InMemoryAnomalyPolicyRepository();
  const thresholds = new InMemoryPlatformThresholdSource();
  const metrics = new AnomalyMetrics();
  const eventBus =
    bus ?? new InMemoryEventBus(new InMemoryIdempotencyStore());
  const engine = new AnomalyEngine(
    [
      new StaticThresholdDetector(),
      new RollingBaselineDetector(),
      new RobustZScoreDetector(),
      new EWMADetector(),
    ],
    policies,
    thresholds,
    repo,
    store,
    metrics,
    eventBus,
  );
  return { engine, store, repo, policies, thresholds, metrics, eventBus };
}

async function collectPublished(
  bus: EventBus,
  consumerName: string,
): Promise<AnomaliesDetectedPayload[]> {
  const published: AnomaliesDetectedPayload[] = [];
  await bus.subscribe(
    {
      subject: EventSubjects.ANOMALIES_DETECTED,
      consumerName,
    },
    async (msg, ctrl) => {
      published.push(msg.payload as AnomaliesDetectedPayload);
      await ctrl.ack();
    },
  );
  return published;
}

describe('AnomalyEngine', () => {
  const now = Date.parse('2026-09-05T12:00:00.000Z');

  it('comportamiento normal: serie estable bajo umbral no publica anomalías', async () => {
    const { engine, repo } = createHarness();
    const results = await engine.ingestAndDetect(
      samples({
        tenantId: 'tenant-a',
        count: 80,
        now,
        value: () => 0.45,
      }),
      now,
    );
    expect(results).toEqual([]);
    expect(await repo.findByTenant('tenant-a')).toEqual([]);
  });

  it('spike: el último valor extremo dispara detectores explicables', async () => {
    const { engine } = createHarness();
    const results = await engine.ingestAndDetect(
      samples({
        tenantId: 'tenant-a',
        metricName: 'request_rate',
        count: 40,
        now,
        value: (index) => (index === 39 ? 80 : 10),
      }),
      now,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((item) => item.tenantId === 'tenant-a')).toBe(true);
    expect(results.every((item) => item.score > 0 && item.score <= 1)).toBe(
      true,
    );
    expect(
      results.every((item) => item.metadata.evidence.length > 0),
    ).toBe(true);
    expect(
      results.some((item) =>
        ['rolling_baseline', 'robust_zscore', 'ewma'].includes(item.algorithm),
      ),
    ).toBe(true);
  });

  it('deriva lenta: EWMA detecta el cambio de nivel en ventana larga', async () => {
    const { engine } = createHarness();
    const results = await engine.ingestAndDetect(
      samples({
        tenantId: 'tenant-a',
        metricName: 'request_rate',
        count: 200,
        now,
        value: (index) => 10 + index * 0.05,
      }),
      now,
    );
    const ewma = results.filter((item) => item.algorithm === 'ewma');
    expect(ewma.length).toBeGreaterThan(0);
    expect(ewma[0].metadata.mode).toBe('drift');
    expect(ewma[0].score).toBeGreaterThanOrEqual(0.35);
    expect(ewma[0].metadata.evidence[0].summary).toMatch(/Deriva/i);
  });

  it('datos ausentes: no lanza y no inventa anomalías', async () => {
    const { engine } = createHarness();
    await expect(engine.ingestAndDetect([], now)).resolves.toEqual([]);

    const staleNow = now + 20 * 60_000;
    const stale = await engine.ingestAndDetect(
      samples({
        tenantId: 'tenant-a',
        metricName: 'request_rate',
        count: 40,
        now,
        value: (index) => (index === 39 ? 80 : 10),
      }),
      staleNow,
    );
    expect(stale).toEqual([]);

    const short = await engine.ingestAndDetect(
      samples({
        tenantId: 'tenant-b',
        metricName: 'request_rate',
        count: 2,
        now,
        value: (index) => (index === 1 ? 99 : 1),
      }),
      now,
    );
    expect(short.filter((item) => item.algorithm !== 'static_threshold')).toEqual(
      [],
    );
  });

  it('línea plana: no hay falso positivo; un quiebre sí se reporta', async () => {
    const flatHarness = createHarness();
    const flat = await flatHarness.engine.ingestAndDetect(
      samples({
        tenantId: 'tenant-a',
        metricName: 'request_rate',
        count: 40,
        now,
        value: () => 12,
      }),
      now,
    );
    expect(flat).toEqual([]);

    const breakHarness = createHarness();
    const broken = await breakHarness.engine.ingestAndDetect(
      samples({
        tenantId: 'tenant-a',
        metricName: 'request_rate',
        count: 40,
        now,
        value: (index) => (index === 39 ? 40 : 12),
      }),
      now,
    );
    expect(broken.length).toBeGreaterThan(0);
    expect(
      broken.some((item) =>
        ['flat_break', 'zero_mad_break', 'spike', 'tukey', 'modified_z'].includes(
          item.metadata.mode ?? '',
        ),
      ),
    ).toBe(true);
  });

  it('métricas ruidosas: oscilación acotada no dispara', async () => {
    const { engine } = createHarness();
    const results = await engine.ingestAndDetect(
      samples({
        tenantId: 'tenant-a',
        metricName: 'request_rate',
        count: 80,
        now,
        value: (index) => 10 + 0.08 * ((index % 5) - 2),
      }),
      now,
    );
    expect(results).toEqual([]);
  });

  it('aislamiento cross-tenant: no filtra ni publica al otro tenant', async () => {
    const harness = createHarness();
    const published = await collectPublished(
      harness.eventBus,
      'anomaly-isolation-sink',
    );

    await harness.engine.ingestAndDetect(
      [
        ...samples({
          tenantId: 'tenant-a',
          entityId: 'shared-host',
          metricName: 'request_rate',
          count: 40,
          now,
          value: (index) => (index === 39 ? 80 : 10),
        }),
        ...samples({
          tenantId: 'tenant-b',
          entityId: 'shared-host',
          metricName: 'request_rate',
          count: 40,
          now,
          value: () => 10,
        }),
      ],
      now,
    );

    const forA = await harness.repo.findByTenant('tenant-a');
    const forB = await harness.repo.findByTenant('tenant-b');
    expect(forA.length).toBeGreaterThan(0);
    expect(forA.every((item) => item.tenantId === 'tenant-a')).toBe(true);
    expect(forB).toEqual([]);
    expect(published.length).toBeGreaterThan(0);
    expect(published.every((item) => item.tenantId === 'tenant-a')).toBe(true);
    expect(
      harness.store
        .getWindow('tenant-b', 'shared-host', 'request_rate', '1h', now)
        .every((point) => point.value === 10),
    ).toBe(true);
  });

  it('falsos positivos: umbral estático y ruido no publican', async () => {
    const { engine } = createHarness();
    const underWarn = await engine.ingestAndDetect(
      samples({
        tenantId: 'tenant-a',
        metricName: 'cpu_used_ratio',
        count: 40,
        now,
        value: () => 0.5,
      }),
      now,
    );
    expect(underWarn).toEqual([]);

    const noisyCpu = await engine.ingestAndDetect(
      samples({
        tenantId: 'tenant-c',
        metricName: 'cpu_used_ratio',
        count: 80,
        now,
        value: (index) => 0.4 + 0.02 * ((index % 3) - 1),
      }),
      now,
    );
    expect(noisyCpu).toEqual([]);
  });

  it('umbral estático reusa PlatformThresholds del tenant', async () => {
    const { engine, thresholds } = createHarness();
    thresholds.set('tenant-a', { cpuWarn: 0.6, cpuCrit: 0.8 });
    const results = await engine.ingestAndDetect(
      samples({
        tenantId: 'tenant-a',
        metricName: 'cpu_used_ratio',
        count: 12,
        now,
        value: () => 0.95,
      }),
      now,
    );
    const staticHit = results.find((item) => item.algorithm === 'static_threshold');
    expect(staticHit).toBeDefined();
    expect(staticHit?.metadata.thresholdSource).toBe('platform_thresholds');
    expect(staticHit?.metadata.stats?.warn).toBe(0.6);
    expect(staticHit?.metadata.stats?.crit).toBe(0.8);
  });

  it('la política de un tenant no aplica a otro', async () => {
    const { engine, policies } = createHarness();
    await policies.upsert({
      id: 'pol-a',
      tenantId: 'tenant-a',
      metricName: 'cpu_used_ratio',
      warn: 0.2,
      crit: 0.3,
    });
    const forB = await engine.ingestAndDetect(
      samples({
        tenantId: 'tenant-b',
        metricName: 'cpu_used_ratio',
        count: 12,
        now,
        value: () => 0.4,
      }),
      now,
    );
    expect(forB.filter((item) => item.algorithm === 'static_threshold')).toEqual(
      [],
    );
  });

  it('publica ekumetrics.anomalies.detected con tenantId en payload y headers', async () => {
    const { engine, eventBus } = createHarness();
    const headers: string[] = [];
    await eventBus.subscribe(
      {
        subject: EventSubjects.ANOMALIES_DETECTED,
        consumerName: 'anomaly-payload-sink',
      },
      async (msg, ctrl) => {
        const payload = msg.payload as AnomaliesDetectedPayload;
        expect(payload.tenantId).toBe('tenant-a');
        expect(msg.headers.tenantId).toBe('tenant-a');
        expect(payload.anomalies.length).toBeGreaterThan(0);
        headers.push(msg.headers.tenantId);
        await ctrl.ack();
      },
    );
    await engine.ingestAndDetect(
      samples({
        tenantId: 'tenant-a',
        metricName: 'request_rate',
        count: 40,
        now,
        value: (index) => (index === 39 ? 80 : 10),
      }),
      now,
    );
    expect(headers).toEqual(['tenant-a']);
  });

  it('stubs avanzados no emiten resultados', () => {
    const ctx = {
      tenantId: 'tenant-a',
      entityId: 'host-1',
      metricName: 'cpu_used_ratio',
      points: [{ timestamp: now, value: 99 }],
      now,
      window: '24h' as const,
      policy: {
        tenantId: 'tenant-a',
        enabledDetectors: ['change_point' as const],
        minScore: 0,
        minSamples: 1,
        ewmaAlpha: 0.3,
        ewmaLambda: 0.05,
        robustZThreshold: 3.5,
        rollingIqrK: 1.5,
        staleMs: 5 * 60_000,
        direction: 'above' as const,
      },
      thresholds: {
        availabilityWarn: 0,
        availabilityCrit: 1,
        errorBudgetWarn: 0,
        errorBudgetCrit: 1,
        latencyWarn: 0,
        latencyCrit: 1,
        freshnessWarn: 0,
        freshnessCrit: 1,
        saturationWarn: 0,
        saturationCrit: 1,
        cpuWarn: 0,
        cpuCrit: 1,
        memWarn: 0,
        memCrit: 1,
        diskWarn: 0,
        diskCrit: 1,
        netWarn: 0,
        netCrit: 1,
        errorsWarn: 0,
        errorsCrit: 1,
        p95Warn: 0,
        p95Crit: 1,
      },
    };
    expect(new ChangePointDetectorStub().detect(ctx)).toEqual([]);
    expect(new IsolationForestDetectorStub().detect(ctx)).toEqual([]);
    expect(new SeasonalBaselineDetectorStub().detect(ctx)).toEqual([]);
  });
});

describe('AnomalyWorker EventBus', () => {
  const now = Date.parse('2026-09-05T12:00:00.000Z');

  it('consume events.ingested y publica anomalies.detected con tenantId', async () => {
    const bus = new InMemoryEventBus(new InMemoryIdempotencyStore());
    const harness = createHarness(bus);
    const worker = new AnomalyWorker(bus, harness.engine);
    await worker.onModuleInit();
    const published = await collectPublished(bus, 'worker-anomaly-sink');
    const wallNow = Date.now();

    await bus.publish(EventSubjects.EVENTS_INGESTED, {
      payload: {
        tenantId: 'tenant-a',
        samples: samples({
          tenantId: 'tenant-a',
          metricName: 'request_rate',
          count: 40,
          now: wallNow,
          value: (index) => (index === 39 ? 80 : 10),
        }),
      },
      headers: buildHeaders({
        tenantId: 'tenant-a',
        correlationId: 'corr-worker-1',
        producedBy: 'test',
      }),
      idempotencyKey: 'tenant-a:events.ingested:worker-1',
    });

    expect(published.length).toBeGreaterThan(0);
    expect(published[0].tenantId).toBe('tenant-a');
    expect(published[0].anomalies.every((item: AnomalyResult) => item.tenantId === 'tenant-a')).toBe(
      true,
    );
    await worker.onModuleDestroy();
  });

  it('rechaza payload de otro tenant (term)', async () => {
    const bus = new InMemoryEventBus(new InMemoryIdempotencyStore());
    const harness = createHarness(bus);
    const worker = new AnomalyWorker(bus, harness.engine);
    const ctrl = { ack: jest.fn(), nak: jest.fn(), term: jest.fn() };
    await worker.handle(
      {
        subject: EventSubjects.EVENTS_INGESTED,
        payload: { tenantId: 'tenant-b', value: 1 },
        headers: buildHeaders({
          tenantId: 'tenant-a',
          correlationId: 'corr-mismatch',
          producedBy: 'test',
        }),
        idempotencyKey: 'mismatch-1',
        attempt: 1,
        ackRef: 'ack-1',
      },
      ctrl,
    );
    expect(ctrl.term).toHaveBeenCalledWith('tenantId header/payload mismatch');
    expect(ctrl.ack).not.toHaveBeenCalled();
  });
});

describe('AnomalyMetrics', () => {
  it('expone series aiops_anomalies_detected_total y duration', () => {
    const metrics = new AnomalyMetrics();
    metrics.record(0.08, { robust_zscore: 2, ewma: 1 });
    const output = metrics.render();
    expect(output).toContain(
      '# TYPE aiops_anomaly_detection_duration_seconds histogram',
    );
    expect(output).toContain(
      'aiops_anomaly_detection_duration_seconds_count 1',
    );
    expect(output).toContain('# TYPE aiops_anomalies_detected_total counter');
    expect(output).toContain(
      'aiops_anomalies_detected_total{algorithm="robust_zscore"} 2',
    );
    expect(output).toContain(
      'aiops_anomalies_detected_total{algorithm="ewma"} 1',
    );
  });
});
