import { Injectable } from '@nestjs/common';
import { TelemetryClient, type InstantRow, type LogLine } from '../../../dashboard/telemetry.client';

const LABEL_SAFE = /[^a-zA-Z0-9_.:-]/g;

export function promLabel(value: string): string {
  return value.replace(LABEL_SAFE, '').slice(0, 128);
}

@Injectable()
export class InvestigationTelemetryPort {
  constructor(private readonly telemetry: TelemetryClient) {}

  selector(tenantSlug: string, extra?: string): string {
    const tenant = promLabel(tenantSlug);
    const parts = [tenant ? `tenant_id="${tenant}"` : '', extra].filter(Boolean);
    return parts.join(',');
  }

  windowSeconds(windowStart?: string, windowEnd?: string): number {
    if (!windowStart || !windowEnd) return 3600;
    const start = Date.parse(windowStart);
    const end = Date.parse(windowEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return 3600;
    }
    return Math.min(7200, Math.max(300, Math.round((end - start) / 1000)));
  }

  async instant(query: string): Promise<InstantRow[]> {
    return this.telemetry.instant(query);
  }

  async lokiLines(
    query: string,
    seconds: number,
    limit: number,
    range?: { startMs: number; endMs: number },
  ): Promise<LogLine[]> {
    return this.telemetry.lokiLines(query, seconds, limit, range);
  }
}
