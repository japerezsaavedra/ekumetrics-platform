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
  name: string;
  status: string;
  startTimeUnixNano: string;
  durationNanos: string;
  durationMs: number;
  attributes: Record<string, string>;
  events: Array<{ name: string; ts: number; attributes: Record<string, string> }>;
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
    range?: { startMs: number; endMs: number },
  ): Promise<TempoTrace[]> {
    const end = range
      ? Math.floor(range.endMs / 1000)
      : Math.floor(Date.now() / 1000);
    const start = range
      ? Math.floor(range.startMs / 1000)
      : end - seconds;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      return [];
    }
    const cappedLimit = Math.min(Math.max(1, limit), 100);
    const cappedSpans = Math.min(Math.max(1, spansPerSpanSet), 20);
    const url = `${this.tempoUrl()}/api/search?${new URLSearchParams({
      q: query,
      start: String(start),
      end: String(end),
      limit: String(cappedLimit),
      spss: String(cappedSpans),
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
      .slice(0, cappedLimit)
      .map((trace) => ({
        traceId: (trace.traceID ?? '').toLowerCase().padStart(32, '0'),
        rootServiceName: (trace.rootServiceName ?? '').slice(0, 200),
        rootTraceName: (trace.rootTraceName ?? '').slice(0, 300),
        startTimeUnixNano: trace.startTimeUnixNano ?? '',
        durationMs: Number.isFinite(trace.durationMs)
          ? Number(trace.durationMs)
          : 0,
        spans: (trace.spanSets ?? [])
          .flatMap((spanSet) => spanSet.spans ?? [])
          .slice(0, spansPerSpanSet)
          .map((span) => {
            const durationNanos = span.durationNanos ?? '';
            const durationMs = Number(durationNanos) / 1_000_000;
            return {
              spanId: /^[a-fA-F0-9]{16}$/.test(span.spanID ?? '')
                ? (span.spanID ?? '')
                : '',
              name: String(
                (span as { name?: string }).name ?? '',
              ).slice(0, 300),
              status: '',
              startTimeUnixNano: span.startTimeUnixNano ?? '',
              durationNanos,
              durationMs: Number.isFinite(durationMs) ? durationMs : 0,
              attributes: this.tempoAttributes(span.attributes ?? []),
              events: [],
            };
          }),
      }));
  }

  async tempoTrace(traceId: string): Promise<TempoTrace | null> {
    if (!/^[a-fA-F0-9]{16,32}$/.test(traceId)) {
      return null;
    }
    const id = traceId.toLowerCase().padStart(32, '0');
    const response = await fetch(`${this.tempoUrl()}/api/traces/${id}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new ServiceUnavailableException(
        'Tempo no esta disponible para la consulta.',
      );
    }
    const body = (await response.json()) as {
      batches?: Array<{
        resource?: { attributes?: Array<{ key?: string; value?: Record<string, unknown> }> };
        scopeSpans?: Array<{
          spans?: Array<{
            spanId?: string;
            parentSpanId?: string;
            name?: string;
            kind?: string | number;
            startTimeUnixNano?: string;
            endTimeUnixNano?: string;
            status?: { code?: string | number; message?: string };
            attributes?: Array<{ key?: string; value?: Record<string, unknown> }>;
            events?: Array<{
              name?: string;
              timeUnixNano?: string;
              attributes?: Array<{ key?: string; value?: Record<string, unknown> }>;
            }>;
          }>;
        }>;
      }>;
    };
    const resource = this.tempoAttributes(body.batches?.[0]?.resource?.attributes ?? []);
    const spans = (body.batches ?? []).flatMap((batch) => {
      const resourceAttrs = this.tempoAttributes(batch.resource?.attributes ?? []);
      return (batch.scopeSpans ?? []).flatMap((scope) =>
        (scope.spans ?? []).map((span) => {
          const start = span.startTimeUnixNano ?? '';
          const end = span.endTimeUnixNano ?? '';
          const durationNanos =
            start && end
              ? this.nanoDiff(start, end)
              : '0';
          const durationMs = Number(durationNanos) / 1_000_000;
          const statusCode = span.status?.code;
          const status =
            statusCode === 2 || statusCode === 'STATUS_CODE_ERROR' || statusCode === 'ERROR'
              ? 'error'
              : span.status?.message || String(statusCode ?? '');
          const attributes: Record<string, string> = {
              ...resourceAttrs,
              ...this.tempoAttributes(span.attributes ?? []),
          };
          if (span.kind !== undefined) {
            attributes['span.kind'] = String(span.kind);
          }
          if (span.parentSpanId) {
            const parent = span.parentSpanId.toLowerCase();
            attributes['parent.span.id'] = parent.length > 16 ? parent.slice(-16) : parent;
          }
          if (span.status?.message) {
            attributes['status.message'] = span.status.message.slice(0, 300);
          }
          return {
            spanId: /^[a-fA-F0-9]{16}$/.test(span.spanId ?? '')
              ? (span.spanId ?? '').toLowerCase()
              : '',
            name: (span.name ?? '').slice(0, 300),
            status: status.slice(0, 80),
            startTimeUnixNano: start,
            durationNanos,
            durationMs: Number.isFinite(durationMs) ? durationMs : 0,
            attributes,
            events: (span.events ?? []).slice(0, 20).map((event) => ({
              name: (event.name ?? '').slice(0, 200),
              ts: this.nanoToMs(event.timeUnixNano ?? ''),
              attributes: this.tempoAttributes(event.attributes ?? []),
            })),
          };
        }),
      );
    });
    spans.sort((left, right) => {
      if (left.startTimeUnixNano === right.startTimeUnixNano) return 0;
      return left.startTimeUnixNano < right.startTimeUnixNano ? -1 : 1;
    });
    const root =
      spans.find((span) => !span.attributes['parent.span.id']) ?? spans[0];
    return {
      traceId: id,
      rootServiceName: (resource['service.name'] ?? root?.attributes['service.name'] ?? '').slice(0, 200),
      rootTraceName: (root?.name ?? '').slice(0, 300),
      startTimeUnixNano: root?.startTimeUnixNano ?? '',
      durationMs: (() => {
        const start = spans
          .map((span) => span.startTimeUnixNano)
          .filter(Boolean)
          .sort()[0];
        const ends = spans.map((span) => {
          try {
            const from = BigInt(span.startTimeUnixNano || '0');
            const dur = BigInt(span.durationNanos || '0');
            return from + dur;
          } catch {
            return 0n;
          }
        });
        const last = ends.reduce((max, value) => (value > max ? value : max), 0n);
        if (!start || last === 0n) {
          return spans.reduce((max, span) => Math.max(max, span.durationMs), 0);
        }
        try {
          const wall = last - BigInt(start);
          return wall > 0n ? Number(wall) / 1_000_000 : 0;
        } catch {
          return spans.reduce((max, span) => Math.max(max, span.durationMs), 0);
        }
      })(),
      spans: spans.slice(0, 80),
    };
  }

  private nanoToMs(value: string): number {
    if (!value) return 0;
    return Number(value.slice(0, Math.max(0, value.length - 6))) || 0;
  }

  private nanoDiff(start: string, end: string): string {
    try {
      const left = BigInt(start);
      const right = BigInt(end);
      return right > left ? String(right - left) : '0';
    } catch {
      return '0';
    }
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
    const blocked =
      /password|secret|token|authorization|cookie|credential|api[_-]?key/i;
    const result: Record<string, string> = {};
    for (const item of attributes) {
      if (!item.key || blocked.test(item.key) || !item.value) continue;
      const value = Object.values(item.value).find(
        (candidate) =>
          typeof candidate === 'string' ||
          typeof candidate === 'number' ||
          typeof candidate === 'boolean',
      );
      if (value === undefined) continue;
      result[item.key] = String(value).slice(0, 300);
      if (Object.keys(result).length >= 40) break;
    }
    return result;
  }
}
