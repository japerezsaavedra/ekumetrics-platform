import {
  aggregateHopSources,
  aggregatePathConfidence,
  aggregateRelationshipConfidence,
  edgeConfidence,
  relationshipSourceGroup,
} from './topology-correlation.confidence';
import type { RelationshipFact } from './topology-correlation.types';

function fact(
  overrides: Partial<RelationshipFact> &
    Pick<RelationshipFact, 'source' | 'confidence'>,
): RelationshipFact {
  return {
    fromKey: 'srv-01',
    toKey: 'sw-03',
    relation: 'CONNECTS_TO',
    ...overrides,
  };
}

describe('topology-correlation.confidence', () => {
  it('clasifica fuentes del recolector, OpenTelemetry y CMDB', () => {
    expect(relationshipSourceGroup('lldp')).toBe('collector');
    expect(relationshipSourceGroup('otel')).toBe('otel');
    expect(relationshipSourceGroup('cmdb')).toBe('cmdb');
    expect(relationshipSourceGroup('inferred')).toBe('inferred');
  });

  it('usa GraphEdge.confidence cuando existe', () => {
    expect(edgeConfidence(fact({ source: 'inferred', confidence: 0.91 }))).toBe(
      0.91,
    );
  });

  it('puntúa más alto recolector + OpenTelemetry + CMDB que una relación débil inferida', () => {
    const combined = aggregateHopSources([
      fact({ source: 'lldp', confidence: 0.55 }),
      fact({ source: 'otel', confidence: 0.65 }),
      fact({ source: 'cmdb', confidence: 0.8 }),
    ]);
    const weak = aggregateHopSources([
      fact({ source: 'inferred', confidence: 0.2 }),
    ]);
    expect(combined).toBeGreaterThan(0.85);
    expect(weak).toBeLessThan(0.3);
    expect(combined).toBeGreaterThan(weak);
  });

  it('agrega hops de un camino con media geométrica', () => {
    expect(aggregatePathConfidence([1, 1, 1])).toBe(1);
    expect(aggregatePathConfidence([0.9, 0.2])).toBeLessThan(0.5);
  });

  it('agrega varias aristas agrupando (from, to, relation)', () => {
    const score = aggregateRelationshipConfidence([
      fact({ source: 'lldp', confidence: 0.5 }),
      fact({ source: 'cmdb', confidence: 0.7 }),
      {
        fromKey: 'api-checkout',
        toKey: 'k8s-node-a',
        relation: 'RUNS_ON',
        source: 'inferred',
        confidence: 0.2,
      },
    ]);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(
      aggregateHopSources([
        fact({ source: 'lldp', confidence: 0.5 }),
        fact({ source: 'cmdb', confidence: 0.7 }),
      ]),
    );
  });
});
