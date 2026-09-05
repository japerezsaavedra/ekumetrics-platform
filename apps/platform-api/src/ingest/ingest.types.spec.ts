import { BadRequestException } from '@nestjs/common';
import { parseEventBatch } from './ingest.types';

const validEvent = {
  timestamp: '2026-08-26T12:00:00Z',
  tenant_id: 'cliente',
  site_id: 'santiago',
  agent_id: 'agent-01',
  asset_id: 'site/santiago/ip/10.0.0.1',
  asset_type: 'switch',
  signal: 'asset_discovered',
  value: 1,
  severity: 'info',
  source: 'discovery',
  tags: { ip: '10.0.0.1', environment: 'production' },
};

describe('parseEventBatch', () => {
  it('normaliza un envelope válido', () => {
    const [event] = parseEventBatch([validEvent]);
    expect(event.timestamp.toISOString()).toBe('2026-08-26T12:00:00.000Z');
    expect(event.tenantId).toBe('cliente');
    expect(event.tags.ip).toBe('10.0.0.1');
  });

  it('acepta neighbor_observed', () => {
    const [event] = parseEventBatch([
      {
        ...validEvent,
        signal: 'neighbor_observed',
        tags: {
          ...validEvent.tags,
          neighbor_key: 'site/santiago/ip/10.0.0.2',
          neighbor_source: 'lldp',
        },
      },
    ]);
    expect(event.signal).toBe('neighbor_observed');
    expect(event.tags.neighbor_key).toBe('site/santiago/ip/10.0.0.2');
  });

  it('rechaza señales desconocidas', () => {
    expect(() =>
      parseEventBatch([{ ...validEvent, signal: 'unknown' }]),
    ).toThrow(BadRequestException);
  });

  it('rechaza identidades mezcladas en el mismo lote', () => {
    expect(() =>
      parseEventBatch([validEvent, { ...validEvent, agent_id: 'agent-02' }]),
    ).toThrow('Todos los eventos del lote deben pertenecer al mismo agente');
    expect(() =>
      parseEventBatch([validEvent, { ...validEvent, tenant_id: 'otro' }]),
    ).toThrow('Todos los eventos del lote deben pertenecer al mismo agente');
  });

  it('limita el tamaño del lote', () => {
    expect(() =>
      parseEventBatch(Array.from({ length: 257 }, () => validEvent)),
    ).toThrow('máximo de 256 eventos');
  });

  it('infiere category, entityType y environment en envelopes antiguos', () => {
    const [event] = parseEventBatch([validEvent]);
    expect(event.category).toBe('ASSET');
    expect(event.entityType).toBe('switch');
    expect(event.environment).toBe('production');
    expect(event.fingerprintExtras).toEqual({});
  });

  it('acepta campos AIOps opcionales y normaliza metadata', () => {
    const [event] = parseEventBatch([
      {
        ...validEvent,
        signal: 'metric.anomaly',
        category: 'metric_signal',
        entity_type: 'K8S_POD',
        correlation_key: 'checkout-cpu',
        environment: 'staging',
        trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
        metadata: {
          anomaly_score: 3.2,
          metric_name: 'container_cpu_usage',
          entity_id: 'ns/checkout/pod-1',
          span_id: '00f067aa0ba902b7',
          baseline: 0.2,
          deviation: 0.7,
          labels: { app: 'checkout' },
          attributes: { replicas: 3, ready: true },
        },
      },
    ]);
    expect(event.category).toBe('METRIC_SIGNAL');
    expect(event.entityType).toBe('K8S_POD');
    expect(event.correlationKey).toBe('checkout-cpu');
    expect(event.environment).toBe('staging');
    expect(event.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(event.metadata).toEqual({
      anomalyScore: 3.2,
      metricName: 'container_cpu_usage',
      entityId: 'ns/checkout/pod-1',
      spanId: '00f067aa0ba902b7',
      baseline: 0.2,
      deviation: 0.7,
      labels: { app: 'checkout' },
      attributes: { replicas: 3, ready: true },
    });
    expect(event.fingerprintExtras).toEqual(
      expect.objectContaining({
        category: 'METRIC_SIGNAL',
        entity_type: 'K8S_POD',
        correlation_key: 'checkout-cpu',
      }),
    );
  });

  it('acepta señales AIOps nuevas y rechaza category inválida', () => {
    expect(
      parseEventBatch([{ ...validEvent, signal: 'alert.received' }])[0]
        .category,
    ).toBe('ALERT');
    expect(() =>
      parseEventBatch([{ ...validEvent, category: 'UNKNOWN' }]),
    ).toThrow('category no admitida');
  });

  it('rechaza metadata con campos no admitidos', () => {
    expect(() =>
      parseEventBatch([
        { ...validEvent, metadata: { tenant_id: 'otro-tenant' } },
      ]),
    ).toThrow('metadata no admite el campo');
  });

  it('rechaza attributes anidados y anomaly_score no finito', () => {
    expect(() =>
      parseEventBatch([
        { ...validEvent, metadata: { attributes: { nested: { a: 1 } } } },
      ]),
    ).toThrow('metadata.attributes inválido');
    expect(() =>
      parseEventBatch([
        {
          ...validEvent,
          metadata: { anomaly_score: Number.POSITIVE_INFINITY },
        },
      ]),
    ).toThrow('debe ser un número finito');
  });

  it('omite metadata vacía en envelopes antiguos', () => {
    const [event] = parseEventBatch([validEvent]);
    expect(event.metadata).toBeUndefined();
  });
});
