import { TOPOLOGY_RELATIONS } from '../topology.relations';
import { NEUTRAL_HISTORICAL_SCORE, RCA_ALGORITHM } from './constants';
import {
  DEFAULT_RCA_WEIGHTS,
  loadRcaWeights,
  normalizeRcaWeights,
} from './scoring-policy';
import { combineRcaScore, scoreRcaCandidates } from './scorer';
import type { RcaEntityInput, RcaGraphEdge, RcaScoreContext } from './types';

const T0 = new Date('2026-09-05T10:00:00.000Z');

function at(offsetSeconds: number): Date {
  return new Date(T0.getTime() + offsetSeconds * 1000);
}

function entity(
  id: string,
  kind: string,
  observed: Date,
  extras: Partial<RcaEntityInput> = {},
): RcaEntityInput {
  return {
    entityId: id,
    entityType: kind,
    name: extras.name ?? id,
    firstObservedAt: observed,
    historicalAvailable: false,
    historicalScore: NEUTRAL_HISTORICAL_SCORE,
    ...extras,
  };
}

function chainEdges(tenantId = 'tenant-a'): RcaGraphEdge[] {
  return [
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
  ];
}

function context(
  partial: Partial<RcaScoreContext> &
    Pick<RcaScoreContext, 'entities' | 'affectedEntityIds' | 'edges'>,
): RcaScoreContext {
  return {
    tenantId: 'tenant-a',
    incidentId: 'inc-1',
    hops: 8,
    weights: DEFAULT_RCA_WEIGHTS,
    observations: [],
    ...partial,
  };
}

describe('RcaEngine scoring', () => {
  it('prioriza PostgreSQL sobre Frontend cuando la dependencia falla aguas arriba', () => {
    const scored = scoreRcaCandidates(
      context({
        entities: [
          entity('postgres', 'database', at(0), {
            name: 'PostgreSQL PROD',
            anomaly: {
              tenantId: 'tenant-a',
              entityId: 'postgres',
              entityType: 'database',
              score: 0.94,
              confidence: 1,
              metric: 'latency',
              startedAt: at(0),
            },
          }),
          entity('api', 'service', at(34), { name: 'API Pagos' }),
          entity('frontend', 'frontend', at(40), { name: 'Frontend' }),
        ],
        affectedEntityIds: ['postgres', 'api', 'frontend'],
        edges: chainEdges(),
      }),
    );

    expect(scored[0].entityId).toBe('postgres');
    expect(scored[0].score).toBeGreaterThan(
      scored.find((item) => item.entityId === 'frontend')!.score,
    );
    expect(scored[0].subscores.dependencyScore).toBeGreaterThan(
      scored.find((item) => item.entityId === 'frontend')!.subscores
        .dependencyScore,
    );
    expect(scored[0].hypothesis).toMatch(/candidato principal/);
    expect(scored[0].hypothesis).toMatch(/0\.94/);
    expect(scored[0].evidence.length).toBeGreaterThan(0);
    expect(scored[0].algorithm).toBe(RCA_ALGORITHM);
  });

  it('sube temporalScore si el candidato ocurre antes del fallo aguas abajo, sin tratarlo como causalidad', () => {
    const scored = scoreRcaCandidates(
      context({
        entities: [
          entity('postgres', 'database', at(0), { name: 'PostgreSQL' }),
          entity('api', 'service', at(34), { name: 'API' }),
        ],
        affectedEntityIds: ['postgres', 'api'],
        edges: chainEdges(),
      }),
    );
    const postgres = scored.find((item) => item.entityId === 'postgres')!;
    const api = scored.find((item) => item.entityId === 'api')!;
    expect(postgres.subscores.temporalScore).toBeGreaterThan(
      api.subscores.temporalScore,
    );
    expect(
      postgres.evidence.some((item) =>
        item.summary.includes(
          'no una prueba de causalidad',
        ),
      ),
    ).toBe(true);
  });

  it('no da score causal alto a alertas cercanas en el tiempo sin topología (falso positivo)', () => {
    const scored = scoreRcaCandidates(
      context({
        entities: [
          entity('billing', 'service', at(0), {
            name: 'Billing',
            anomaly: {
              tenantId: 'tenant-a',
              entityId: 'billing',
              score: 0.9,
              confidence: 0.9,
              metric: 'errors',
              startedAt: at(0),
            },
          }),
          entity('printer', 'device', at(2), {
            name: 'Printer',
            anomaly: {
              tenantId: 'tenant-a',
              entityId: 'printer',
              score: 0.88,
              confidence: 0.9,
              metric: 'errors',
              startedAt: at(2),
            },
          }),
        ],
        affectedEntityIds: ['billing', 'printer'],
        edges: [],
      }),
    );
    for (const item of scored) {
      expect(item.subscores.topologyScore).toBe(0);
      expect(item.subscores.temporalScore).toBe(0.5);
      expect(item.score).toBeLessThan(0.6);
      expect(item.confidence).toBeLessThan(0.6);
    }
  });

  it('usa historicalScore neutro 0.5 si no hay evidencia histórica', () => {
    const scored = scoreRcaCandidates(
      context({
        entities: [
          entity('postgres', 'database', at(0), {
            historicalAvailable: false,
            historicalScore: 0.99,
          }),
          entity('api', 'service', at(10)),
        ],
        affectedEntityIds: ['postgres', 'api'],
        edges: chainEdges(),
      }),
    );
    for (const item of scored) {
      expect(item.subscores.historicalScore).toBe(NEUTRAL_HISTORICAL_SCORE);
      expect(
        item.evidence.some((ev) =>
          ev.summary.includes('historicalScore neutro'),
        ),
      ).toBe(true);
    }
  });

  it('incluye evidencia explicable con score, confidence y algoritmo', () => {
    const [leading] = scoreRcaCandidates(
      context({
        entities: [
          entity('postgres', 'database', at(0), {
            name: 'PostgreSQL PROD',
            anomaly: {
              tenantId: 'tenant-a',
              entityId: 'postgres',
              score: 0.94,
              confidence: 0.91,
              metric: 'latency',
              startedAt: at(0),
            },
          }),
          entity('api', 'service', at(34), { name: 'API Pagos' }),
        ],
        affectedEntityIds: ['postgres', 'api'],
        edges: chainEdges(),
      }),
    );
    expect(leading.hypothesis).toMatch(/PostgreSQL PROD/);
    expect(leading.hypothesis).toMatch(/algoritmo weighted_subscores_v1/);
    expect(leading.score).toBeGreaterThan(0);
    expect(leading.confidence).toBeGreaterThan(0);
    expect(leading.evidence.every((item) => item.summary.trim().length > 0)).toBe(
      true,
    );
    expect(
      leading.evidence.every((item) => item.facts.algorithm === RCA_ALGORITHM),
    ).toBe(true);
    expect(leading.evidence.some((item) => item.kind === 'metric')).toBe(true);
    expect(leading.evidence.some((item) => item.kind === 'topology')).toBe(
      true,
    );
  });

  it('cambia el ranking al reconfigurar pesos', () => {
    const temporalHeavy = normalizeRcaWeights({
      temporal: 0.7,
      topology: 0.075,
      anomaly: 0.075,
      dependency: 0.075,
      historical: 0.075,
    });
    const dependencyHeavy = normalizeRcaWeights({
      temporal: 0.05,
      topology: 0.1,
      anomaly: 0.05,
      dependency: 0.7,
      historical: 0.1,
    });
    const earlyLeaf = {
      temporalScore: 1,
      topologyScore: 0.15,
      anomalyScore: 0.2,
      dependencyScore: 0.2,
      historicalScore: 0.5,
    };
    const upstreamDb = {
      temporalScore: 0.2,
      topologyScore: 0.8,
      anomalyScore: 0.4,
      dependencyScore: 1,
      historicalScore: 0.5,
    };
    expect(combineRcaScore(earlyLeaf, temporalHeavy)).toBeGreaterThan(
      combineRcaScore(upstreamDb, temporalHeavy),
    );
    expect(combineRcaScore(upstreamDb, dependencyHeavy)).toBeGreaterThan(
      combineRcaScore(earlyLeaf, dependencyHeavy),
    );
    expect(combineRcaScore(upstreamDb, DEFAULT_RCA_WEIGHTS)).toBeGreaterThan(
      combineRcaScore(earlyLeaf, DEFAULT_RCA_WEIGHTS),
    );
  });

  it('respeta historicalScore informado cuando el puerto marca available', () => {
    const scored = scoreRcaCandidates(
      context({
        entities: [
          entity('postgres', 'database', at(0), {
            historicalAvailable: true,
            historicalScore: 0.8,
            historicalMatches: 3,
            historicalSummary: '3 incidentes previos del mismo tenant',
          }),
          entity('api', 'service', at(20)),
        ],
        affectedEntityIds: ['postgres', 'api'],
        edges: chainEdges(),
      }),
    );
    const postgres = scored.find((item) => item.entityId === 'postgres')!;
    expect(postgres.subscores.historicalScore).toBe(0.8);
  });
});

describe('rca weights config', () => {
  it('normaliza pesos de env a 1', () => {
    const weights = loadRcaWeights((key) =>
      key === 'AIOPS_RCA_WEIGHT_DEPENDENCY' ? '2' : '1',
    );
    const sum =
      weights.temporal +
      weights.topology +
      weights.anomaly +
      weights.dependency +
      weights.historical;
    expect(sum).toBeCloseTo(1);
    expect(weights.dependency).toBeGreaterThan(weights.temporal);
  });
});
