import { orderTimeline, timelineEntry } from './incident-timeline';

describe('orderTimeline', () => {
  it('ordena por occurredAt y reasigna sequence 1..n', () => {
    const ordered = orderTimeline([
      timelineEntry({
        occurredAt: '2026-09-05T10:31:41.000Z',
        summary: 'HTTP 5xx',
        kind: 'error',
        source: 'test',
      }),
      timelineEntry({
        occurredAt: '2026-09-05T10:31:02.000Z',
        summary: 'DB latency anomaly',
        kind: 'anomaly',
        source: 'test',
      }),
      timelineEntry({
        occurredAt: '2026-09-05T10:31:55.000Z',
        summary: 'pod timeout',
        kind: 'anomaly',
        source: 'test',
      }),
      timelineEntry({
        occurredAt: '2026-09-05T10:31:36.000Z',
        summary: 'API latency',
        kind: 'anomaly',
        source: 'test',
      }),
      timelineEntry({
        occurredAt: '2026-09-05T10:31:15.000Z',
        summary: 'connection pool saturation',
        kind: 'anomaly',
        source: 'test',
      }),
    ]);

    expect(ordered.map((item) => item.summary)).toEqual([
      'DB latency anomaly',
      'connection pool saturation',
      'API latency',
      'HTTP 5xx',
      'pod timeout',
    ]);
    expect(ordered.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it('desempata same timestamp por kind (anomaly antes que alert)', () => {
    const at = '2026-09-05T10:31:02.000Z';
    const ordered = orderTimeline([
      timelineEntry({
        occurredAt: at,
        summary: 'alerta cruda',
        kind: 'alert',
        source: 'test',
      }),
      timelineEntry({
        occurredAt: at,
        summary: 'anomalia',
        kind: 'anomaly',
        source: 'test',
      }),
    ]);
    expect(ordered[0].kind).toBe('anomaly');
    expect(ordered[1].kind).toBe('alert');
  });
});
