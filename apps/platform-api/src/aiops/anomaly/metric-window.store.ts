import type { AnomalyWindow } from './anomaly-result';
import { ANOMALY_WINDOW_MS } from './anomaly-result';
import type { MetricPoint, MetricSample } from './metric-sample';
import { seriesKey } from './metric-sample';

const MAX_SERIES = 5_000;
const MAX_POINTS = 1_440;
const BUCKET_MS = 5_000;
const RETENTION_MS = ANOMALY_WINDOW_MS['24h'];

type SeriesState = {
  tenantId: string;
  entityId: string;
  metricName: string;
  siteId?: string;
  entityType?: string;
  environment?: string;
  points: MetricPoint[];
  lastAccess: number;
};

export type SeriesContext = {
  tenantId: string;
  entityId: string;
  metricName: string;
  siteId?: string;
  entityType?: string;
  environment?: string;
};

/**
 * Buffer acotado por serie (tenant|entity|metric). No consulta historial completo
 * ni mezcla tenants.
 */
export class MetricWindowStore {
  private readonly series = new Map<string, SeriesState>();
  private readonly dirty = new Set<string>();

  append(sample: MetricSample): void {
    if (!sample.tenantId) {
      throw new Error('tenantId es obligatorio.');
    }
    const key = seriesKey(sample.tenantId, sample.entityId, sample.metricName);
    const now = sample.timestamp;
    const existing = this.series.get(key);
    const state: SeriesState = existing ?? {
      tenantId: sample.tenantId,
      entityId: sample.entityId,
      metricName: sample.metricName,
      points: [],
      lastAccess: now,
    };
    if (state.tenantId !== sample.tenantId) {
      throw new Error('El registro no pertenece al tenant.');
    }
    state.siteId = sample.siteId ?? state.siteId;
    state.entityType = sample.entityType ?? state.entityType;
    state.environment = sample.environment ?? state.environment;
    state.lastAccess = now;
    const bucket = Math.floor(sample.timestamp / BUCKET_MS) * BUCKET_MS;
    const last = state.points[state.points.length - 1];
    if (last && Math.floor(last.timestamp / BUCKET_MS) * BUCKET_MS === bucket) {
      last.timestamp = sample.timestamp;
      last.value = sample.value;
    } else {
      state.points.push({ timestamp: sample.timestamp, value: sample.value });
    }
    const cutoff = now - RETENTION_MS;
    while (state.points.length && state.points[0].timestamp < cutoff) {
      state.points.shift();
    }
    if (state.points.length > MAX_POINTS) {
      state.points.splice(0, state.points.length - MAX_POINTS);
    }
    this.series.set(key, state);
    this.dirty.add(key);
    this.evictIfNeeded();
  }

  getWindow(
    tenantId: string,
    entityId: string,
    metricName: string,
    window: AnomalyWindow,
    now: number,
  ): MetricPoint[] {
    if (!tenantId) return [];
    const key = seriesKey(tenantId, entityId, metricName);
    const state = this.series.get(key);
    if (!state || state.tenantId !== tenantId) return [];
    const windowMs = ANOMALY_WINDOW_MS[window];
    const from = now - windowMs;
    return state.points
      .filter((point) => point.timestamp > from && point.timestamp <= now)
      .map((point) => ({ ...point }));
  }

  context(
    tenantId: string,
    entityId: string,
    metricName: string,
  ): SeriesContext | null {
    if (!tenantId) return null;
    const state = this.series.get(seriesKey(tenantId, entityId, metricName));
    if (!state || state.tenantId !== tenantId) return null;
    return {
      tenantId: state.tenantId,
      entityId: state.entityId,
      metricName: state.metricName,
      siteId: state.siteId,
      entityType: state.entityType,
      environment: state.environment,
    };
  }

  takeDirty(tenantId: string): SeriesContext[] {
    if (!tenantId) return [];
    const prefix = `${tenantId}\u0000`;
    const out: SeriesContext[] = [];
    for (const key of [...this.dirty]) {
      if (!key.startsWith(prefix)) continue;
      this.dirty.delete(key);
      const state = this.series.get(key);
      if (!state || state.tenantId !== tenantId) continue;
      out.push({
        tenantId: state.tenantId,
        entityId: state.entityId,
        metricName: state.metricName,
        siteId: state.siteId,
        entityType: state.entityType,
        environment: state.environment,
      });
    }
    return out;
  }

  private evictIfNeeded(): void {
    if (this.series.size <= MAX_SERIES) return;
    const oldest = [...this.series.entries()].sort(
      (left, right) => left[1].lastAccess - right[1].lastAccess,
    )[0];
    if (!oldest) return;
    this.series.delete(oldest[0]);
    this.dirty.delete(oldest[0]);
  }
}
