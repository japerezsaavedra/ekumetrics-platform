export type MetricPoint = {
  timestamp: number;
  value: number;
};

export type MetricSample = {
  tenantId: string;
  entityId: string;
  metricName: string;
  value: number;
  timestamp: number;
  siteId?: string;
  entityType?: string;
  environment?: string;
};

const SKIP_SIGNALS = new Set([
  'neighbor_observed',
  'asset_discovered',
  'asset_updated',
  'asset_stale',
  'mac_changed',
  'heartbeat',
]);

const SKIP_CATEGORIES = new Set(['NEIGHBOR', 'ASSET', 'CHANGE', 'DEPLOY']);

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getTime();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOne(raw: unknown, fallbackTenantId: string): MetricSample | null {
  const body = asRecord(raw);
  if (!body) return null;
  const signal = optionalString(body.signal);
  if (signal && SKIP_SIGNALS.has(signal)) return null;
  const category = optionalString(body.category);
  if (category && SKIP_CATEGORIES.has(category)) return null;

  const metadata = asRecord(body.metadata) ?? {};
  const tenantId =
    optionalString(body.tenantId) ??
    optionalString(body.tenant_id) ??
    fallbackTenantId;
  const entityId =
    optionalString(body.entityId) ??
    optionalString(body.entity_id) ??
    optionalString(body.assetKey) ??
    optionalString(body.asset_id) ??
    optionalString(metadata.entityId) ??
    optionalString(metadata.entity_id);
  const metricName =
    optionalString(body.metricName) ??
    optionalString(body.metric_name) ??
    optionalString(metadata.metricName) ??
    optionalString(metadata.metric_name) ??
    signal;
  const value = body.value;
  const timestamp =
    parseTimestamp(body.timestamp) ??
    parseTimestamp(body.eventAt) ??
    parseTimestamp(body.event_at);

  if (!tenantId || !entityId || !metricName || !isFiniteNumber(value)) {
    return null;
  }
  if (timestamp == null) return null;

  return {
    tenantId,
    entityId,
    metricName,
    value,
    timestamp,
    siteId: optionalString(body.siteId) ?? optionalString(body.site_id),
    entityType:
      optionalString(body.entityType) ?? optionalString(body.entity_type),
    environment: optionalString(body.environment),
  };
}

/**
 * Extrae muestras numéricas de un payload de `ekumetrics.events.ingested`.
 * Solo incluye puntos cuyo tenantId coincide con el del header.
 */
export function parseMetricSamples(
  payload: unknown,
  tenantId: string,
): MetricSample[] {
  if (!tenantId) return [];
  const body = asRecord(payload);
  if (!body) return [];
  const sources = Array.isArray(body.samples) ? body.samples : [body];
  const samples: MetricSample[] = [];
  for (const item of sources) {
    const sample = parseOne(item, tenantId);
    if (sample && sample.tenantId === tenantId) {
      samples.push(sample);
    }
  }
  return samples;
}

export function seriesKey(
  tenantId: string,
  entityId: string,
  metricName: string,
): string {
  return `${tenantId}\u0000${entityId}\u0000${metricName}`;
}
