import { BadRequestException } from '@nestjs/common';

export const EKMS_SIGNALS = [
  'asset_discovered',
  'asset_updated',
  'asset_stale',
  'mac_changed',
  'flow.bytes',
  'flow.new',
  'snmp.trap',
  'neighbor_observed',
  'metric.anomaly',
  'log.signal',
  'change.detected',
  'deploy.observed',
  'alert.received',
] as const;

export const EKMS_CATEGORIES = [
  'ALERT',
  'METRIC_SIGNAL',
  'LOG_SIGNAL',
  'CHANGE',
  'DEPLOY',
  'ASSET',
  'NEIGHBOR',
  'FLOW',
  'TRAP',
] as const;

export const CATEGORY_BY_SIGNAL: Record<(typeof EKMS_SIGNALS)[number], string> =
  {
    asset_discovered: 'ASSET',
    asset_updated: 'ASSET',
    asset_stale: 'ASSET',
    mac_changed: 'ASSET',
    'flow.bytes': 'FLOW',
    'flow.new': 'FLOW',
    'snmp.trap': 'TRAP',
    neighbor_observed: 'NEIGHBOR',
    'metric.anomaly': 'METRIC_SIGNAL',
    'log.signal': 'LOG_SIGNAL',
    'change.detected': 'CHANGE',
    'deploy.observed': 'DEPLOY',
    'alert.received': 'ALERT',
  };

const SIGNALS = new Set<string>(EKMS_SIGNALS);
const CATEGORIES = new Set<string>(EKMS_CATEGORIES);
const SEVERITIES = new Set(['info', 'warning', 'error', 'critical']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const METADATA_KEYS = new Set([
  'labels',
  'attributes',
  'baseline',
  'deviation',
  'anomalyScore',
  'anomaly_score',
  'metricName',
  'metric_name',
  'entityId',
  'entity_id',
  'spanId',
  'span_id',
]);

export type EkmsEventMetadata = {
  labels?: Record<string, string>;
  attributes?: Record<string, string | number | boolean>;
  baseline?: number;
  deviation?: number;
  anomalyScore?: number;
  metricName?: string;
  entityId?: string;
  spanId?: string;
};

export type EkmsEvent = {
  timestamp: Date;
  tenantId: string;
  siteId: string;
  agentId: string;
  assetId?: string;
  assetType?: string;
  vendor?: string;
  tier?: number;
  signal: string;
  value: number;
  unit?: string;
  severity?: string;
  source: string;
  tags: Record<string, string>;
  category: string;
  entityType?: string;
  correlationKey?: string;
  environment?: string;
  traceId?: string;
  metadata?: EkmsEventMetadata;
  fingerprintExtras: Record<string, unknown>;
};

export function parseEventBatch(body: unknown): EkmsEvent[] {
  if (!Array.isArray(body)) {
    throw new BadRequestException('El cuerpo debe ser un array JSON');
  }
  if (body.length === 0) {
    throw new BadRequestException('El lote no puede estar vacío');
  }
  if (body.length > 256) {
    throw new BadRequestException('El lote supera el máximo de 256 eventos');
  }
  const events = body.map((item, index) => parseEvent(item, index));
  const first = events[0];
  if (
    events.some(
      (event) =>
        event.tenantId !== first.tenantId ||
        event.siteId !== first.siteId ||
        event.agentId !== first.agentId,
    )
  ) {
    throw new BadRequestException(
      'Todos los eventos del lote deben pertenecer al mismo agente',
    );
  }
  return events;
}

function parseEvent(value: unknown, index: number): EkmsEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(index, 'debe ser un objeto');
  }
  const input = value as Record<string, unknown>;
  const timestampRaw = requiredString(
    input.timestamp,
    index,
    'timestamp',
    64,
    false,
  );
  const timestamp = new Date(timestampRaw);
  if (Number.isNaN(timestamp.getTime())) {
    invalid(index, 'timestamp no es RFC 3339 válido');
  }
  if (timestamp.getTime() > Date.now() + 10 * 60_000) {
    invalid(index, 'timestamp está más de 10 minutos en el futuro');
  }
  const signal = requiredString(input.signal, index, 'signal', 64);
  if (!SIGNALS.has(signal)) {
    invalid(index, `signal no admitida: ${signal}`);
  }
  if (typeof input.value !== 'number' || !Number.isFinite(input.value)) {
    invalid(index, 'value debe ser un número finito');
  }
  const tier = optionalInteger(input.tier, index, 'tier', 0, 10);
  const severity = optionalString(input.severity, index, 'severity', 16);
  if (severity && !SEVERITIES.has(severity)) {
    invalid(index, `severity no admitida: ${severity}`);
  }
  const tags = parseTags(input.tags, index);
  const fingerprintExtras: Record<string, unknown> = {};

  const explicitCategory = parseOptionalCategory(input, index);
  if (explicitCategory) {
    fingerprintExtras.category = explicitCategory;
  }
  const explicitEntityType = takeOptionalString(
    input,
    index,
    'entity_type',
    64,
    fingerprintExtras,
    'entity_type',
  );
  const explicitCorrelationKey = takeOptionalString(
    input,
    index,
    'correlation_key',
    256,
    fingerprintExtras,
    'correlation_key',
  );
  const explicitEnvironment = takeOptionalString(
    input,
    index,
    'environment',
    64,
    fingerprintExtras,
    'environment',
  );
  const explicitTraceId = takeOptionalString(
    input,
    index,
    'trace_id',
    128,
    fingerprintExtras,
    'trace_id',
  );
  const metadata = parseMetadata(input.metadata, index);
  if (Object.hasOwn(input, 'metadata') && metadata) {
    fingerprintExtras.metadata = metadata;
  }

  const assetType = optionalString(input.asset_type, index, 'asset_type', 64);
  return {
    timestamp,
    tenantId: requiredString(input.tenant_id, index, 'tenant_id', 128),
    siteId: requiredString(input.site_id, index, 'site_id', 128),
    agentId: requiredString(input.agent_id, index, 'agent_id', 128),
    assetId: optionalString(input.asset_id, index, 'asset_id', 256),
    assetType,
    vendor: optionalString(input.vendor, index, 'vendor', 128, false),
    tier,
    signal,
    value: input.value,
    unit: optionalString(input.unit, index, 'unit', 32, false),
    severity,
    source: requiredString(input.source, index, 'source', 64),
    tags,
    category:
      explicitCategory ??
      CATEGORY_BY_SIGNAL[signal as (typeof EKMS_SIGNALS)[number]],
    entityType: explicitEntityType ?? assetType,
    correlationKey: explicitCorrelationKey,
    environment: explicitEnvironment ?? tags.environment,
    traceId: explicitTraceId ?? tags.trace_id ?? tags.traceId,
    metadata,
    fingerprintExtras,
  };
}

function parseOptionalCategory(
  input: Record<string, unknown>,
  index: number,
): string | undefined {
  const raw = optionalString(input.category, index, 'category', 32, false);
  if (!raw) {
    return undefined;
  }
  const category = raw.toUpperCase();
  if (!CATEGORIES.has(category)) {
    invalid(index, `category no admitida: ${raw}`);
  }
  return category;
}

function takeOptionalString(
  input: Record<string, unknown>,
  index: number,
  field: string,
  max: number,
  extras: Record<string, unknown>,
  extraKey: string,
): string | undefined {
  const parsed = optionalString(input[field], index, field, max);
  if (parsed) {
    extras[extraKey] = parsed;
  }
  return parsed;
}

function parseMetadata(
  value: unknown,
  index: number,
): EkmsEventMetadata | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    invalid(index, 'metadata debe ser un objeto');
  }
  const input = value as Record<string, unknown>;
  const entries = Object.entries(input);
  if (entries.length > 32) {
    invalid(index, 'metadata supera el máximo de 32 entradas');
  }
  for (const key of Object.keys(input)) {
    if (!METADATA_KEYS.has(key)) {
      invalid(index, `metadata no admite el campo: ${key}`);
    }
  }
  const metadata: EkmsEventMetadata = {};
  const labels = parseStringMap(input.labels, index, 'metadata.labels', 32);
  if (labels) {
    metadata.labels = labels;
  }
  const attributes = parseAttributeMap(input.attributes, index);
  if (attributes) {
    metadata.attributes = attributes;
  }
  const baseline = optionalFinite(input.baseline, index, 'metadata.baseline');
  if (baseline !== undefined) {
    metadata.baseline = baseline;
  }
  const deviation = optionalFinite(
    input.deviation,
    index,
    'metadata.deviation',
  );
  if (deviation !== undefined) {
    metadata.deviation = deviation;
  }
  const anomalyScore = optionalFinite(
    input.anomalyScore ?? input.anomaly_score,
    index,
    'metadata.anomalyScore',
  );
  if (anomalyScore !== undefined) {
    metadata.anomalyScore = anomalyScore;
  }
  const metricName = optionalString(
    input.metricName ?? input.metric_name,
    index,
    'metadata.metricName',
    128,
    false,
  );
  if (metricName) {
    metadata.metricName = metricName;
  }
  const entityId = optionalString(
    input.entityId ?? input.entity_id,
    index,
    'metadata.entityId',
    256,
  );
  if (entityId) {
    metadata.entityId = entityId;
  }
  const spanId = optionalString(
    input.spanId ?? input.span_id,
    index,
    'metadata.spanId',
    64,
  );
  if (spanId) {
    metadata.spanId = spanId;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function parseStringMap(
  value: unknown,
  index: number,
  field: string,
  maxEntries: number,
): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    invalid(index, `${field} debe ser un objeto de strings`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxEntries) {
    invalid(index, `${field} supera el máximo de ${maxEntries} entradas`);
  }
  const mapped: Record<string, string> = {};
  for (const [key, item] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (
      !ID_PATTERN.test(key) ||
      typeof item !== 'string' ||
      item.length > 512
    ) {
      invalid(index, `${field} inválido: ${key}`);
    }
    mapped[key] = item;
  }
  return mapped;
}

function parseAttributeMap(
  value: unknown,
  index: number,
): Record<string, string | number | boolean> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    invalid(index, 'metadata.attributes debe ser un objeto');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) {
    invalid(index, 'metadata.attributes supera el máximo de 32 entradas');
  }
  const mapped: Record<string, string | number | boolean> = {};
  for (const [key, item] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const validType =
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item));
    if (!ID_PATTERN.test(key) || !validType) {
      invalid(index, `metadata.attributes inválido: ${key}`);
    }
    if (typeof item === 'string' && item.length > 512) {
      invalid(index, `metadata.attributes inválido: ${key}`);
    }
    mapped[key] = item as string | number | boolean;
  }
  return mapped;
}

function parseTags(value: unknown, index: number): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    invalid(index, 'tags debe ser un objeto de strings');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) {
    invalid(index, 'tags supera el máximo de 32 entradas');
  }
  const tags: Record<string, string> = {};
  for (const [key, item] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (
      !ID_PATTERN.test(key) ||
      typeof item !== 'string' ||
      item.length > 512
    ) {
      invalid(index, `tag inválido: ${key}`);
    }
    tags[key] = item;
  }
  return tags;
}

function requiredString(
  value: unknown,
  index: number,
  field: string,
  max: number,
  identifier = true,
): string {
  const parsed = optionalString(value, index, field, max, identifier);
  if (!parsed) {
    invalid(index, `${field} es obligatorio`);
  }
  return parsed;
}

function optionalString(
  value: unknown,
  index: number,
  field: string,
  max: number,
  identifier = true,
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (identifier && !ID_PATTERN.test(value))
  ) {
    invalid(index, `${field} no tiene un formato válido`);
  }
  return value;
}

function optionalInteger(
  value: unknown,
  index: number,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    invalid(index, `${field} debe ser un entero entre ${min} y ${max}`);
  }
  return value as number;
}

function optionalFinite(
  value: unknown,
  index: number,
  field: string,
): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(index, `${field} debe ser un número finito`);
  }
  return value;
}

function invalid(index: number, message: string): never {
  throw new BadRequestException(`Evento ${index}: ${message}`);
}
