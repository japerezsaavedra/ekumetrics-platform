import { createHash } from 'node:crypto';
import type {
  IncidentSignatureInput,
  StableSignatureCharacteristics,
} from './types';
import { SIGNATURE_VERSION } from './types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;

/**
 * Extrae características estables y calcula el hash SHA-256.
 * El tenant NO entra en el digest: la unicidad es (tenantId, hash) en el repositorio.
 * IDs volátiles (incidentId, entityIds, fingerprints, timestamps, IPs, UUIDs) se ignoran.
 */
export function buildStableCharacteristics(
  input: IncidentSignatureInput,
): StableSignatureCharacteristics {
  return {
    entityTypes: normalizeSet(input.entityTypes),
    serviceKey: normalizeScalar(input.serviceKey ?? input.service),
    eventTypes: normalizeSet(input.eventTypes),
    anomalyTypes: normalizeSet(input.anomalyTypes),
    topologyPattern: canonicalizeTopology(input.topologyPattern),
    environment: normalizeScalar(input.environment),
  };
}

export function hashIncidentSignature(
  input: IncidentSignatureInput,
): { hash: string; characteristics: StableSignatureCharacteristics } {
  const characteristics = buildStableCharacteristics(input);
  const payload = [
    SIGNATURE_VERSION,
    characteristics.entityTypes.join(','),
    characteristics.serviceKey,
    characteristics.eventTypes.join(','),
    characteristics.anomalyTypes.join(','),
    characteristics.topologyPattern,
    characteristics.environment,
  ].join('|');
  const hash = createHash('sha256').update(payload, 'utf8').digest('hex');
  return { hash, characteristics };
}

export function canonicalizeTopology(
  value: string | string[] | undefined,
): string {
  const tokens = (Array.isArray(value) ? value : splitTopology(value))
    .map((item) => normalizeScalar(item))
    .filter((item) => item.length > 0 && !isVolatileToken(item));
  return tokens.join('>');
}

function splitTopology(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[>,/|]+/);
}

function normalizeSet(values: string[] | undefined): string[] {
  const unique = new Set<string>();
  for (const value of values ?? []) {
    const normalized = normalizeScalar(value);
    if (normalized && !isVolatileToken(normalized)) {
      unique.add(normalized);
    }
  }
  return [...unique].sort();
}

function normalizeScalar(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isVolatileToken(token: string): boolean {
  return UUID_RE.test(token) || IPV4_RE.test(token) || LONG_HEX_RE.test(token);
}
