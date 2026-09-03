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
  });

  it('limita el tamaño del lote', () => {
    expect(() =>
      parseEventBatch(Array.from({ length: 257 }, () => validEvent)),
    ).toThrow('máximo de 256 eventos');
  });
});
