import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { TelemetryClient } from './telemetry.client';

describe('TelemetryClient Tempo', () => {
  const config = {
    get: jest.fn((key: string) =>
      key === 'TEMPO_URL' ? 'http://tempo:3200/' : undefined,
    ),
  };
  const client = new TelemetryClient(config as unknown as ConfigService);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('envia siempre ventana, limite y spans por spanset a Tempo', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          traces: [
            {
              traceID: '0123456789abcdef0123456789abcdef',
              rootServiceName: 'orders',
              rootTraceName: 'GET /orders',
              startTimeUnixNano: '1700000000000000000',
              durationMs: 42,
              spanSets: [],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const traces = await client.tempoSearch('{ status = error }', 3600, 10, 3);

    const requested = fetchMock.mock.calls[0]?.[0];
    expect(typeof requested).toBe('string');
    const url = new URL(requested as string);
    expect(url.origin).toBe('http://tempo:3200');
    expect(url.pathname).toBe('/api/search');
    expect(url.searchParams.get('q')).toBe('{ status = error }');
    expect(Number(url.searchParams.get('end'))).toBeGreaterThan(
      Number(url.searchParams.get('start')),
    );
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('spss')).toBe('3');
    expect(traces[0]?.traceId).toBe('0123456789abcdef0123456789abcdef');
  });

  it('falla cerrado cuando Tempo rechaza la consulta', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 503 }));

    await expect(client.tempoSearch('{}', 60, 1, 1)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
