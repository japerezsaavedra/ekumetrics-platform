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
] as const;

const SIGNALS = new Set<string>(EKMS_SIGNALS);
const SEVERITIES = new Set(['info', 'warning', 'error', 'critical']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

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
  return {
    timestamp,
    tenantId: requiredString(input.tenant_id, index, 'tenant_id', 128),
    siteId: requiredString(input.site_id, index, 'site_id', 128),
    agentId: requiredString(input.agent_id, index, 'agent_id', 128),
    assetId: optionalString(input.asset_id, index, 'asset_id', 256),
    assetType: optionalString(input.asset_type, index, 'asset_type', 64),
    vendor: optionalString(input.vendor, index, 'vendor', 128, false),
    tier,
    signal,
    value: input.value,
    unit: optionalString(input.unit, index, 'unit', 32, false),
    severity,
    source: requiredString(input.source, index, 'source', 64),
    tags: parseTags(input.tags, index),
  };
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

function invalid(index: number, message: string): never {
  throw new BadRequestException(`Evento ${index}: ${message}`);
}
