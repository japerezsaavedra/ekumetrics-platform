import { NeutralHistoricalEvidenceAdapter } from './historical-evidence.port';
import { DeterministicRcaEngine } from './engine';
import { RcaMetrics } from './metrics';
import { NEUTRAL_HISTORICAL_SCORE } from './constants';
import type { AnomalyEvidencePort } from './anomaly-evidence.port';
import type { HistoricalEvidencePort } from './historical-evidence.port';
import type { RcaIncidentSource } from './incident-source';
import type { RcaScoringPolicyLoader } from './scoring-policy';
import { DEFAULT_RCA_HOPS, DEFAULT_RCA_WEIGHTS } from './scoring-policy';
import type { TopologyEntity, TopologyRepository } from '../topology.repository';
import { TOPOLOGY_RELATIONS } from '../topology.relations';
import type { AnomalyResult, RcaIncidentRecord } from './types';

const T0 = new Date('2026-09-05T10:00:00.000Z');

function node(
  tenantId: string,
  key: string,
  kind: string,
  name = key,
): TopologyEntity {
  return {
    id: `${tenantId}-${key}`,
    tenantId,
    siteId: 'site-1',
    entityKey: key,
    kind,
    name,
    source: 'test',
    lastSeenAt: T0,
    createdAt: T0,
    updatedAt: T0,
  };
}

class FakeTopology implements Pick<TopologyRepository, 'getEntity'> {
  constructor(private readonly nodes: TopologyEntity[]) {}

  getEntity(tenantId: string, entityKey: string): Promise<TopologyEntity | null> {
    return Promise.resolve(
      this.nodes.find(
        (item) => item.tenantId === tenantId && item.entityKey === entityKey,
      ) ?? null,
    );
  }
}

function incident(
  tenantId: string,
  id: string,
  extras: Partial<RcaIncidentRecord> = {},
): RcaIncidentRecord {
  return {
    id,
    tenantId,
    siteId: 'site-1',
    clusterKey: 'cluster-1',
    causeKey: 'postgres',
    causeName: 'PostgreSQL',
    windowStart: T0,
    windowEnd: new Date(T0.getTime() + 40_000),
    members: {
      alerts: [
        {
          fingerprint: 'fp-pg',
          name: 'PostgresLatency',
          severity: 'critical',
          nodeHint: 'postgres',
          startsAt: T0.toISOString(),
        },
        {
          fingerprint: 'fp-api',
          name: 'ApiErrors',
          severity: 'error',
          nodeHint: 'api',
          startsAt: new Date(T0.getTime() + 34_000).toISOString(),
        },
        {
          fingerprint: 'fp-fe',
          name: 'FrontendErrors',
          severity: 'warning',
          nodeHint: 'frontend',
          startsAt: new Date(T0.getTime() + 40_000).toISOString(),
        },
      ],
      impact: ['api', 'frontend'],
      collectorEvents: [],
    },
    ...extras,
  };
}

function sourceFor(rows: RcaIncidentRecord[]): RcaIncidentSource {
  return {
    getIncident: (tenantId, incidentId) =>
      Promise.resolve(
        rows.find((row) => row.id === incidentId && row.tenantId === tenantId) ??
          null,
      ),
    getCollectorEvents: (tenantId) => {
      if (!tenantId) return Promise.resolve([]);
      return Promise.resolve([]);
    },
    getGraph: (tenantId) =>
      Promise.resolve({
        nodes: [
          {
            entityKey: 'postgres',
            kind: 'database',
            name: 'PostgreSQL PROD',
            tenantId,
          },
          { entityKey: 'api', kind: 'service', name: 'API Pagos', tenantId },
          {
            entityKey: 'frontend',
            kind: 'frontend',
            name: 'Frontend',
            tenantId,
          },
        ].filter((item) => item.tenantId === tenantId),
        edges:
          tenantId === 'tenant-a'
            ? [
                {
                  fromKey: 'frontend',
                  toKey: 'api',
                  relation: TOPOLOGY_RELATIONS.DEPENDS_ON,
                  tenantId,
                },
                {
                  fromKey: 'api',
                  toKey: 'postgres',
                  relation: TOPOLOGY_RELATIONS.DEPENDS_ON,
                  tenantId,
                },
              ]
            : [],
      }),
  };
}

function anomaliesFor(tenantId: string): AnomalyEvidencePort {
  return {
    findForIncident: (query) => {
      if (query.tenantId !== tenantId) return Promise.resolve([]);
      const row: AnomalyResult = {
        tenantId,
        entityId: 'postgres',
        entityType: 'database',
        score: 0.94,
        confidence: 0.91,
        metric: 'latency',
        startedAt: T0,
      };
      return Promise.resolve([row]);
    },
  };
}

function policy(): RcaScoringPolicyLoader {
  return {
    getWeights: (tenantId: string) => {
      if (!tenantId) throw new Error('tenantId required');
      return Promise.resolve(DEFAULT_RCA_WEIGHTS);
    },
    getHops: (tenantId: string) => {
      if (!tenantId) throw new Error('tenantId required');
      return Promise.resolve(DEFAULT_RCA_HOPS);
    },
  } as RcaScoringPolicyLoader;
}

function engine(opts: {
  incidents: RcaIncidentSource;
  topology: Pick<TopologyRepository, 'getEntity'>;
  historical?: HistoricalEvidencePort;
  anomalies?: AnomalyEvidencePort;
}) {
  return new DeterministicRcaEngine(
    opts.incidents,
    opts.topology as TopologyRepository,
    opts.historical ?? new NeutralHistoricalEvidenceAdapter(),
    opts.anomalies ?? anomaliesFor('tenant-a'),
    policy(),
    new RcaMetrics(),
  );
}

describe('DeterministicRcaEngine', () => {
  it('produce candidatos explicables con tenantId y no usa LLM', async () => {
    const rca = engine({
      incidents: sourceFor([incident('tenant-a', 'inc-1')]),
      topology: new FakeTopology([
        node('tenant-a', 'postgres', 'database', 'PostgreSQL PROD'),
        node('tenant-a', 'api', 'service', 'API Pagos'),
        node('tenant-a', 'frontend', 'frontend', 'Frontend'),
      ]),
    });
    const result = await rca.propose({
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].entityKey).toBe('postgres');
    expect(result[0].entityId).toBe('postgres');
    expect(result[0].tenantId).toBe('tenant-a');
    expect(result[0].source).toBe('deterministic_rca');
    expect(result[0].hypothesis).toMatch(/PostgreSQL PROD/);
    expect(result[0].evidence.length).toBeGreaterThan(0);
    expect(result.every((item) => item.tenantId === 'tenant-a')).toBe(true);
    expect(result[0].subscores?.historicalScore).toBe(NEUTRAL_HISTORICAL_SCORE);
  });

  it('aísla tenants: no lee el incidente ni el grafo de otro tenant', async () => {
    const incidents = sourceFor([
      incident('tenant-a', 'inc-a'),
      incident('tenant-b', 'inc-b', { causeKey: 'other-db' }),
    ]);
    const historicalCalls: string[] = [];
    const historical: HistoricalEvidencePort = {
      lookup: (query) => {
        historicalCalls.push(query.tenantId);
        return Promise.resolve({
          available: false,
          score: NEUTRAL_HISTORICAL_SCORE,
          priorMatches: 0,
        });
      },
    };
    const anomalyCalls: string[] = [];
    const anomalies: AnomalyEvidencePort = {
      findForIncident: (query) => {
        anomalyCalls.push(query.tenantId);
        return Promise.resolve([]);
      },
    };
    const rca = engine({
      incidents,
      topology: new FakeTopology([
        node('tenant-a', 'postgres', 'database'),
        node('tenant-b', 'other-db', 'database'),
      ]),
      historical,
      anomalies,
    });

    const fromA = await rca.propose({
      tenantId: 'tenant-a',
      incidentId: 'inc-b',
    });
    expect(fromA).toEqual([]);

    const fromB = await rca.propose({
      tenantId: 'tenant-b',
      incidentId: 'inc-a',
    });
    expect(fromB).toEqual([]);

    const ok = await rca.propose({ tenantId: 'tenant-a', incidentId: 'inc-a' });
    expect(ok.length).toBeGreaterThan(0);
    expect(ok.every((item) => item.tenantId === 'tenant-a')).toBe(true);
    expect(historicalCalls.every((id) => id === 'tenant-a')).toBe(true);
    expect(anomalyCalls.every((id) => id === 'tenant-a')).toBe(true);
  });

  it('exige tenantId', async () => {
    const rca = engine({
      incidents: sourceFor([]),
      topology: new FakeTopology([]),
    });
    await expect(
      rca.propose({ tenantId: '', incidentId: 'inc-1' }),
    ).rejects.toThrow(/tenantId/);
  });
});
