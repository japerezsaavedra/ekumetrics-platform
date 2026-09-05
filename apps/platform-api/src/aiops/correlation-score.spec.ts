import { GRAPH_EXAMPLE_EDGES as edges } from './graph-example';
import { hopDistance, scoreCluster } from './correlation-score';
import { DEFAULT_CORRELATION_WEIGHTS } from './correlation-weights';
import type { CorrelateAlert } from './correlation-types';

const windowMs = 5 * 60_000;
const hops = 4;

function alert(
  overrides: Partial<CorrelateAlert> & Pick<CorrelateAlert, 'fingerprint'>,
): CorrelateAlert {
  return {
    name: overrides.name ?? overrides.fingerprint,
    severity: overrides.severity ?? 'warning',
    siteId: overrides.siteId ?? 'santiago',
    nodeHint: overrides.nodeHint,
    startsAt: overrides.startsAt ?? '2026-09-04T12:00:00.000Z',
    labels: overrides.labels,
    fingerprint: overrides.fingerprint,
  };
}

describe('correlation-score', () => {
  it('puntúa más alto cuando las alertas están más cerca en el tiempo', () => {
    const close = scoreCluster({
      items: [
        {
          alert: alert({
            fingerprint: 'a',
            startsAt: '2026-09-04T12:00:00.000Z',
          }),
          nodeKey: 'api-pagos',
        },
        {
          alert: alert({
            fingerprint: 'b',
            startsAt: '2026-09-04T12:00:43.000Z',
          }),
          nodeKey: 'postgres',
        },
      ],
      edges,
      windowMs,
      hops,
      weights: DEFAULT_CORRELATION_WEIGHTS,
      historical: { priorSameCluster: 0, priorSimilarCause: 0 },
    });
    const far = scoreCluster({
      items: [
        {
          alert: alert({
            fingerprint: 'a',
            startsAt: '2026-09-04T12:00:00.000Z',
          }),
          nodeKey: 'api-pagos',
        },
        {
          alert: alert({
            fingerprint: 'b',
            startsAt: '2026-09-04T12:04:00.000Z',
          }),
          nodeKey: 'postgres',
        },
      ],
      edges,
      windowMs,
      hops,
      weights: DEFAULT_CORRELATION_WEIGHTS,
      historical: { priorSameCluster: 0, priorSimilarCause: 0 },
    });
    expect(close.components.temporalScore).toBeGreaterThan(
      far.components.temporalScore,
    );
    expect(close.evidence.some((line) => line.includes('43 segundos'))).toBe(
      true,
    );
  });

  it('declara que la correlación temporal no es causalidad', () => {
    const scored = scoreCluster({
      items: [
        { alert: alert({ fingerprint: 'a' }), nodeKey: 'api-pagos' },
        { alert: alert({ fingerprint: 'b' }), nodeKey: 'postgres' },
      ],
      edges,
      windowMs,
      hops,
      weights: DEFAULT_CORRELATION_WEIGHTS,
      historical: { priorSameCluster: 0, priorSimilarCause: 0 },
    });
    expect(
      scored.evidence.some((line) =>
        line.includes('no demuestra que una alerta cause la otra'),
      ),
    ).toBe(true);
    expect(
      scored.details.some(
        (item) =>
          item.kind === 'causality' && item.details?.temporalIsNotCausal,
      ),
    ).toBe(true);
  });

  it('da entityScore 1 cuando todas las alertas son la misma entidad', () => {
    const scored = scoreCluster({
      items: [
        { alert: alert({ fingerprint: 'a' }), nodeKey: 'api-pagos' },
        { alert: alert({ fingerprint: 'b' }), nodeKey: 'api-pagos' },
      ],
      edges,
      windowMs,
      hops,
      weights: DEFAULT_CORRELATION_WEIGHTS,
      historical: { priorSameCluster: 0, priorSimilarCause: 0 },
    });
    expect(scored.components.entityScore).toBe(1);
    expect(scored.evidence).toContain('Misma entidad: api-pagos');
  });

  it('puntúa topología por distancia de hops', () => {
    expect(hopDistance('app-01', 'api-pagos', edges, 4)).toBe(1);
    expect(hopDistance('api-pagos', 'postgres', edges, 4)).toBe(4);
    const near = scoreCluster({
      items: [
        { alert: alert({ fingerprint: 'a' }), nodeKey: 'app-01' },
        { alert: alert({ fingerprint: 'b' }), nodeKey: 'api-pagos' },
      ],
      edges,
      windowMs,
      hops,
      weights: DEFAULT_CORRELATION_WEIGHTS,
      historical: { priorSameCluster: 0, priorSimilarCause: 0 },
    });
    const far = scoreCluster({
      items: [
        { alert: alert({ fingerprint: 'a' }), nodeKey: 'api-pagos' },
        { alert: alert({ fingerprint: 'b' }), nodeKey: 'postgres' },
      ],
      edges,
      windowMs,
      hops,
      weights: DEFAULT_CORRELATION_WEIGHTS,
      historical: { priorSameCluster: 0, priorSimilarCause: 0 },
    });
    expect(near.components.topologyScore).toBeGreaterThan(
      far.components.topologyScore,
    );
    expect(near.evidence).toContain('Camino de dependencia a distancia 1');
  });

  it('puntúa etiquetas compartidas (aplicación, job, servicio)', () => {
    const scored = scoreCluster({
      items: [
        {
          alert: alert({
            fingerprint: 'a',
            labels: { application: 'pagos', job: 'api' },
          }),
          nodeKey: 'api-pagos',
        },
        {
          alert: alert({
            fingerprint: 'b',
            labels: { application: 'pagos', job: 'api' },
          }),
          nodeKey: 'postgres',
        },
      ],
      edges,
      windowMs,
      hops,
      weights: DEFAULT_CORRELATION_WEIGHTS,
      historical: { priorSameCluster: 0, priorSimilarCause: 0 },
    });
    expect(scored.components.labelScore).toBeGreaterThan(0);
    expect(
      scored.evidence.some((line) => line.includes('application=pagos')),
    ).toBe(true);
  });

  it('sube historicalScore con incidentes previos del mismo tenant', () => {
    const none = scoreCluster({
      items: [
        { alert: alert({ fingerprint: 'a' }), nodeKey: 'api-pagos' },
        { alert: alert({ fingerprint: 'b' }), nodeKey: 'postgres' },
      ],
      edges,
      windowMs,
      hops,
      weights: DEFAULT_CORRELATION_WEIGHTS,
      historical: { priorSameCluster: 0, priorSimilarCause: 0 },
    });
    const prior = scoreCluster({
      items: [
        { alert: alert({ fingerprint: 'a' }), nodeKey: 'api-pagos' },
        { alert: alert({ fingerprint: 'b' }), nodeKey: 'postgres' },
      ],
      edges,
      windowMs,
      hops,
      weights: DEFAULT_CORRELATION_WEIGHTS,
      historical: { priorSameCluster: 2, priorSimilarCause: 1 },
    });
    expect(prior.components.historicalScore).toBeGreaterThan(
      none.components.historicalScore,
    );
    expect(prior.evidence.some((line) => line.includes('3 incidentes'))).toBe(
      true,
    );
  });

  it('cambia el total si se altera un peso configurable', () => {
    const items = [
      { alert: alert({ fingerprint: 'a' }), nodeKey: 'api-pagos' },
      { alert: alert({ fingerprint: 'b' }), nodeKey: 'postgres' },
    ];
    const balanced = scoreCluster({
      items,
      edges,
      windowMs,
      hops,
      weights: DEFAULT_CORRELATION_WEIGHTS,
      historical: { priorSameCluster: 0, priorSimilarCause: 0 },
    });
    const temporalOnly = scoreCluster({
      items,
      edges,
      windowMs,
      hops,
      weights: {
        temporal: 1,
        entity: 0,
        topology: 0,
        label: 0,
        historical: 0,
      },
      historical: { priorSameCluster: 0, priorSimilarCause: 0 },
    });
    expect(temporalOnly.score).toBe(temporalOnly.components.temporalScore);
    expect(temporalOnly.score).not.toBe(balanced.score);
  });

  it('expone score + evidence[] en lenguaje claro', () => {
    const scored = scoreCluster({
      items: [
        {
          alert: alert({
            fingerprint: 'a',
            labels: { application: 'pagos' },
          }),
          nodeKey: 'api-pagos',
        },
        {
          alert: alert({
            fingerprint: 'b',
            startsAt: '2026-09-04T12:00:43.000Z',
            labels: { application: 'pagos' },
          }),
          nodeKey: 'app-01',
        },
      ],
      edges,
      windowMs,
      hops,
      weights: DEFAULT_CORRELATION_WEIGHTS,
      historical: { priorSameCluster: 0, priorSimilarCause: 0 },
    });
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.score).toBeLessThanOrEqual(1);
    expect(scored.evidence.length).toBeGreaterThanOrEqual(5);
    expect(scored.components).toEqual(
      expect.objectContaining({
        temporalScore: expect.any(Number),
        entityScore: expect.any(Number),
        topologyScore: expect.any(Number),
        labelScore: expect.any(Number),
        historicalScore: expect.any(Number),
      }),
    );
  });
});
