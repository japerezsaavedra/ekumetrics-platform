import { Injectable } from '@nestjs/common';
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

@Injectable()
export class TelemetryClient {
  constructor(private readonly config: ConfigService) {}

  prometheusUrl(): string {
    return (this.config.get<string>('PROMETHEUS_URL') ?? 'http://127.0.0.1:9091').replace(
      /\/$/,
      '',
    );
  }

  lokiUrl(): string {
    return (this.config.get<string>('LOKI_URL') ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
  }

  async instant(query: string): Promise<InstantRow[]> {
    const url = `${this.prometheusUrl()}/api/v1/query?query=${encodeURIComponent(query)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = (await response.json()) as {
      data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> };
    };
    return (body.data?.result ?? []).map((row) => ({
      metric: row.metric ?? {},
      value: Number(row.value?.[1] ?? Number.NaN),
    }));
  }

  async range(query: string, seconds: number, step: number): Promise<RangeSeries[]> {
    const end = Math.floor(Date.now() / 1000);
    const start = end - seconds;
    const url = `${this.prometheusUrl()}/api/v1/query_range?${new URLSearchParams({
      query,
      start: String(start),
      end: String(end),
      step: String(step),
    }).toString()}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = (await response.json()) as {
      data?: {
        result?: Array<{
          metric?: Record<string, string>;
          values?: Array<[number, string]>;
        }>;
      };
    };
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
    const url = `${this.lokiUrl()}/loki/api/v1/query_range?${new URLSearchParams({
      query,
      start: String(start),
      end: String(end),
      step: String(step),
    }).toString()}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = (await response.json()) as {
      data?: { result?: Array<{ values?: Array<[number | string, string]> }> };
    };
    const values = body.data?.result?.[0]?.values ?? [];
    return values
      .map(([ts, raw]) => [Number(ts), Number(raw)] as [number, number])
      .filter(([, value]) => Number.isFinite(value));
  }

  async lokiLines(query: string, seconds: number, limit: number): Promise<LogLine[]> {
    const end = Date.now() * 1_000_000;
    const start = end - seconds * 1_000_000_000;
    const url = `${this.lokiUrl()}/loki/api/v1/query_range?${new URLSearchParams({
      query,
      start: String(start),
      end: String(end),
      limit: String(limit),
      direction: 'backward',
    }).toString()}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = (await response.json()) as {
      data?: { result?: Array<{ values?: Array<[string, string]> }> };
    };
    return (body.data?.result ?? [])
      .flatMap((stream) => stream.values ?? [])
      .slice(0, limit)
      .map(([ts, raw]) => {
        const parsed = this.parseLog(raw);
        return {
          ts: Number(ts.length > 13 ? ts.slice(0, 13) : ts),
          line: parsed.line,
          fields: parsed.fields,
        };
      });
  }

  first(rows: InstantRow[]): number | null {
    const value = rows[0]?.value;
    return value !== undefined && Number.isFinite(value) ? value : null;
  }

  private parseLog(raw: string): { line: string; fields: Record<string, string> } {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { line: raw, fields: {} };
      }
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value == null || typeof value === 'object') {
          continue;
        }
        fields[key] = String(value);
      }
      return { line: fields.MESSAGE ?? raw, fields };
    } catch {
      return { line: raw, fields: {} };
    }
  }
}
