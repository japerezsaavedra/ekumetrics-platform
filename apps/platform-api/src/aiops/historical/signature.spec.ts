import { hashIncidentSignature } from './signature';
import type { IncidentSignatureInput } from './types';

const base = (): IncidentSignatureInput => ({
  tenantId: 'tenant-a',
  entityTypes: ['K8S_POD', 'service'],
  service: 'checkout',
  eventTypes: ['alert.received', 'metric.anomaly'],
  anomalyTypes: ['latency'],
  topologyPattern: ['database', 'service', 'ingress'],
  environment: 'production',
});

describe('hashIncidentSignature estabilidad', () => {
  it('ignora IDs volátiles (incidentId, entityIds, fingerprints, timestamps, UUIDs, IPs)', () => {
    const left = hashIncidentSignature({
      ...base(),
      incidentId: 'inc-1',
      entityIds: ['pod-abc-123'],
      entityKeys: ['checkout-7f8a9c'],
      nodeKeys: ['node-1'],
      fingerprints: ['fp-aaaa'],
      timestamps: ['2026-09-05T10:31:02Z'],
      assetIds: ['asset-9'],
      topologyPattern:
        'database>550e8400-e29b-41d4-a716-446655440000>service>10.0.0.8>ingress',
    });
    const right = hashIncidentSignature({
      ...base(),
      incidentId: 'inc-2',
      entityIds: ['pod-zzz-999'],
      entityKeys: ['checkout-other'],
      nodeKeys: ['node-99'],
      fingerprints: ['fp-bbbb'],
      timestamps: [new Date('2026-01-01T00:00:00Z')],
      assetIds: ['asset-1'],
      topologyPattern: ['database', 'service', 'ingress'],
    });
    expect(left.hash).toBe(right.hash);
    expect(left.characteristics.topologyPattern).toBe(
      'database>service>ingress',
    );
  });

  it('cambia el hash si cambia un atributo estable (servicio o patrón de eventos)', () => {
    const original = hashIncidentSignature(base());
    const otherService = hashIncidentSignature({
      ...base(),
      service: 'billing',
    });
    const otherEvents = hashIncidentSignature({
      ...base(),
      eventTypes: ['log.signal'],
    });
    expect(otherService.hash).not.toBe(original.hash);
    expect(otherEvents.hash).not.toBe(original.hash);
  });

  it('normaliza mayúsculas, orden de sets y alias service/serviceKey', () => {
    const a = hashIncidentSignature({
      ...base(),
      entityTypes: ['service', 'K8S_POD'],
      serviceKey: 'Checkout',
      eventTypes: ['metric.anomaly', 'alert.received'],
    });
    const b = hashIncidentSignature(base());
    expect(a.hash).toBe(b.hash);
  });

  it('el tenantId no entra en el digest (unicidad es tenant-scoped en el repositorio)', () => {
    const a = hashIncidentSignature({ ...base(), tenantId: 'tenant-a' });
    const b = hashIncidentSignature({ ...base(), tenantId: 'tenant-b' });
    expect(a.hash).toBe(b.hash);
  });
});
