import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type InstantRow = {
  metric: Record<string, string>;
  value: number;
};

export type RangeSeries = {
  metric: Record<string, string>;
  values: Array<[number, number]>;
};

export type LogLine = {
  ts: number;
  line: string;
  fields: Record<string, string>;
};

export type TempoSpan = {
  spanId: string;
  startTimeUnixNano: string;
  durationNanos: string;
  attributes: Record<string, string>;
};

export type TempoTrace = {
  traceId: string;
  rootServiceName: string;
  rootTraceName: string;
  startTimeUnixNano: string;
  durationMs: number;
  spans: TempoSpan[];
};

@Injectable()
export class TelemetryClient {
  constructor(private readonly config: ConfigService) {}

  prometheusUrl(): string {
    return (
      this.config.get<string>('PROMETHEUS_URL') ?? 'http://127.0.0.1:9091'
    ).replace(/\/$/, '');
  }

  lokiUrl(): string {
    return (
      this.config.get<string>('LOKI_URL') ?? 'http://127.0.0.1:3100'
    ).replace(/\/$/, '');
  }

  tempoUrl(): string {
    return (
      this.config.get<string>('TEMPO_URL') ?? 'http://127.0.0.1:3200'
    ).replace(/\/$/, '');
  }

  async instant(query: string): Promise<InstantRow[]> {
    const url = `${this.prometheusUrl()}/api/v1/query?query=${encodeURIComponent(query)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = (await response.json()) as {
      status?: string;
      data?: {
        result?: Array<{
          metric?: Record<string, string>;
          value?: [number, string];
        }>;
      };
    };
    this.assertResponse(response, body.status, 'Prometheus');
    return (body.data?.result ?? []).map((row) => ({
      metric: row.metric ?? {},
      value: Number(row.value?.[1] ?? Number.NaN),
    }));
  }

  async range(
    query: string,
    seconds: number,
    step: number,
  ): Promise<RangeSeries[]> {
    const end = Math.floor(Date.now() / 1000);
    const start = end - seconds;
    const url = `${this.prometheusUrl()}/api/v1/query_range?${new URLSearchParams(
      {
        query,
        start: String(start),
        end: String(end),
        step: String(step),
      },
    ).toString()}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body = (await response.json()) as {
      status?: string;
      data?: {
        result?: Array<{
          metric?: Record<string, string>;
          values?: Array<[number, string]>;
        }>;
      };
    };
    this.assertResponse(response, body.status, 'Prometheus');
    return (body.data?.result ?? []).map((row) => ({
      metric: row.metric ?? {},
      values: (row.values ?? [])
        .map(([ts, raw]) => [Number(ts), Number(raw)] as [number, number])
        .filter(([, value]) => Number.isFinite(value)),
    }));
  }

  async lokiRange(
    query: string,
    seconds: number,
    step: number,
  ): Promise<Array<[number, number]>> {
    const end = Math.floor(Date.now() / 1000);
    const start = end - seconds;
    const url = `${this.lokiUrl()}/loki/api/v1/query_range?${new URLSearchParams(
      {
        query,
        start: String(start),
        end: String(end),
        step: String(step),
      },
    ).toString()}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body = (await response.json()) as {
      status?: string;
      data?: { result?: Array<{ values?: Array<[number | string, string]> }> };
    };
    this.assertResponse(response, body.status, 'Loki');
    const values = body.data?.result?.[0]?.values ?? [];
    return values
      .map(([ts, raw]) => [Number(ts), Number(raw)] as [number, number])
      .filter(([, value]) => Number.isFinite(value));
  }

  async lokiLines(
    query: string,
    seconds: number,
    limit: number,
    range?: { startMs: number; endMs: number },
  ): Promise<LogLine[]> {
    const end = (range?.endMs ?? Date.now()) * 1_000_000;
    const start = range
      ? range.startMs * 1_000_000
      : end - seconds * 1_000_000_000;
    const url = `${this.lokiUrl()}/loki/api/v1/query_range?${new URLSearchParams(
      {
        query,
        start: String(start),
        end: String(end),
        limit: String(limit),
        direction: 'backward',
      },
    ).toString()}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body = (await response.json()) as {
      status?: string;
      data?: {
        result?: Array<{
          stream?: Record<string, string>;
          values?: Array<[string, string]>;
        }>;
      };
    };
    this.assertResponse(response, body.status, 'Loki');
    return (body.data?.result ?? [])
      .flatMap((stream) =>
        (stream.values ?? []).map(
          ([ts, raw]) => [ts, raw, stream.stream ?? {}] as const,
        ),
      )
      .slice(0, limit)
      .map(([ts, raw, streamFields]) => {
        const parsed = this.parseLog(raw);
        return {
          ts: Number(ts.length > 13 ? ts.slice(0, 13) : ts),
          line: parsed.line,
          fields: { ...streamFields, ...parsed.fields },
        };
      });
  }

  async tempoSearch(
    query: string,
    seconds: number,
    limit: number,
    spansPerSpanSet: number,
  ): Promise<TempoTrace[]> {
    const end = Math.floor(Date.now() / 1000);
    const start = end - seconds;
    const url = `${this.tempoUrl()}/api/search?${new URLSearchParams({
      q: query,
      start: String(start),
      end: String(end),
      limit: String(limit),
      spss: String(spansPerSpanSet),
    }).toString()}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body = (await response.json()) as {
      traces?: Array<{
        traceID?: string;
        rootServiceName?: string;
        rootTraceName?: string;
        startTimeUnixNano?: string;
        durationMs?: number;
        spanSets?: Array<{
          spans?: Array<{
            spanID?: string;
            startTimeUnixNano?: string;
            durationNanos?: string;
            attributes?: Array<{
              key?: string;
              value?: Record<string, unknown>;
            }>;
          }>;
        }>;
      }>;
    };
    if (!response.ok) {
      throw new ServiceUnavailableException(
        'Tempo no esta disponible para la consulta.',
      );
    }
    return (body.traces ?? [])
      .filter((trace) => /^[a-fA-F0-9]{16,32}$/.test(trace.traceID ?? ''))
      .slice(0, limit)
      .map((trace) => ({
        traceId: (trace.traceID ?? '').toLowerCase(),
        rootServiceName: (trace.rootServiceName ?? '').slice(0, 200),
        rootTraceName: (trace.rootTraceName ?? '').slice(0, 300),
        startTimeUnixNano: trace.startTimeUnixNano ?? '',
        durationMs: Number.isFinite(trace.durationMs)
          ? Number(trace.durationMs)
          : 0,
        spans: (trace.spanSets ?? [])
          .flatMap((spanSet) => spanSet.spans ?? [])
          .slice(0, spansPerSpanSet)
          .map((span) => ({
            spanId: /^[a-fA-F0-9]{16}$/.test(span.spanID ?? '')
              ? (span.spanID ?? '')
              : '',
            startTimeUnixNano: span.startTimeUnixNano ?? '',
            durationNanos: span.durationNanos ?? '',
            attributes: this.tempoAttributes(span.attributes ?? []),
          })),
      }));
  }

  first(rows: InstantRow[]): number | null {
    const value = rows[0]?.value;
    return value !== undefined && Number.isFinite(value) ? value : null;
  }

  private assertResponse(
    response: Response,
    status: string | undefined,
    source: string,
  ) {
    if (!response.ok || status === 'error') {
      throw new ServiceUnavailableException(
        `${source} no esta disponible para la consulta.`,
      );
    }
  }

  private parseLog(raw: string): {
    line: string;
    fields: Record<string, string>;
  } {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { line: raw, fields: {} };
      }
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          fields[key] = String(value);
        }
      }
      return { line: fields.MESSAGE ?? raw, fields };
    } catch {
      return { line: raw, fields: {} };
    }
  }

  private tempoAttributes(
    attributes: Array<{ key?: string; value?: Record<string, unknown> }>,
  ): Record<string, string> {
    const safe = new Set([
      'service.name',
      'service.namespace',
      'service.instance.id',
      'tenant.id',
      'host.site',
      'agent.id',
      'status',
      'http.request.method',
      'http.response.status_code',
      'db.system.name',
      'messaging.system',
    ]);
    const result: Record<string, string> = {};
    for (const item of attributes) {
      if (!item.key || !safe.has(item.key) || !item.value) continue;
      const value = Object.values(item.value).find(
        (candidate) =>
          typeof candidate === 'string' ||
          typeof candidate === 'number' ||
          typeof candidate === 'boolean',
      );
      if (value !== undefined) result[item.key] = String(value).slice(0, 300);
    }
    return result;
  }
}
