import { DISAGREEMENT_CAP, scoreSignatureSimilarity } from './similarity';
import { hashIncidentSignature } from './signature';
import type { IncidentSignature } from './types';

function asSignature(
  tenantId: string,
  input: Parameters<typeof hashIncidentSignature>[0],
): IncidentSignature {
  const { hash, characteristics } = hashIncidentSignature({
    ...input,
    tenantId,
  });
  return {
    id: `sig-${hash.slice(0, 8)}`,
    tenantId,
    hash,
    version: 'v1',
    incidentIds: ['hist-1'],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...characteristics,
  };
}

describe('scoreSignatureSimilarity', () => {
  const query = hashIncidentSignature({
    tenantId: 't',
    entityTypes: ['service', 'database'],
    service: 'checkout',
    eventTypes: ['metric.anomaly', 'alert.received'],
    anomalyTypes: ['latency'],
    topologyPattern: 'database>service',
    environment: 'production',
  }).characteristics;

  it('devuelve similitud alta cuando coinciden las dimensiones estables', () => {
    const candidate = asSignature('t', {
      tenantId: 't',
      entityTypes: ['database', 'service'],
      service: 'checkout',
      eventTypes: ['alert.received', 'metric.anomaly'],
      anomalyTypes: ['latency'],
      topologyPattern: 'database>service',
      environment: 'production',
    });
    const scored = scoreSignatureSimilarity(query, candidate);
    expect(scored.similarity).toBeGreaterThanOrEqual(0.99);
    expect(scored.evidence.algorithm).toBe('deterministic_jaccard_v1');
    expect(scored.evidence.source).toBe('historical_intelligence');
    expect(scored.dimensions.every((item) => item.skipped || item.matched)).toBe(
      true,
    );
  });

  it('falso positivo: mismo servicio y entorno pero topología y eventos distintos no se acerca a 1.0', () => {
    const candidate = asSignature('t', {
      tenantId: 't',
      entityTypes: ['host'],
      service: 'checkout',
      eventTypes: ['disk.full'],
      anomalyTypes: ['saturation'],
      topologyPattern: 'switch>host',
      environment: 'production',
    });
    const scored = scoreSignatureSimilarity(query, candidate);
    expect(scored.similarity).toBeLessThanOrEqual(DISAGREEMENT_CAP);
    expect(scored.similarity).toBeLessThan(0.5);
    const events = scored.dimensions.find((d) => d.dimension === 'eventTypes');
    const topology = scored.dimensions.find(
      (d) => d.dimension === 'topologyPattern',
    );
    expect(events?.score).toBe(0);
    expect(topology?.score).toBe(0);
  });

  it('bonus si la causa raíz confirmada coincide', () => {
    const candidate = asSignature('t', {
      tenantId: 't',
      entityTypes: ['database', 'service'],
      service: 'checkout',
      eventTypes: ['alert.received', 'metric.anomaly'],
      anomalyTypes: ['latency'],
      topologyPattern: 'database>service',
      environment: 'production',
    });
    const without = scoreSignatureSimilarity(query, candidate);
    const withCause = scoreSignatureSimilarity(query, candidate, {
      queryRootCause: 'postgres.prod',
      resolution: {
        incidentId: 'hist-1',
        confirmedRootCause: 'postgres.prod',
        rejectedRootCauses: [],
      },
    });
    expect(withCause.similarity).toBeGreaterThanOrEqual(without.similarity);
    expect(
      withCause.dimensions.some(
        (item) => item.dimension === 'rootCause' && item.matched,
      ),
    ).toBe(true);
  });
});
