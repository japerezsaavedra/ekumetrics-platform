import { roundScore } from '../correlation-score';
import type {
  RelationshipFact,
  RelationshipSourceGroup,
} from './topology-correlation.types';

const COLLECTOR_SOURCES = new Set([
  'lldp',
  'cdp',
  'snmp',
  'neighbor',
  'neighbor_observed',
  'connection',
  'ekumetrics-agent',
  'collector',
]);

const OTEL_SOURCES = new Set([
  'otel',
  'opentelemetry',
  'otlp',
  'trace',
  'span',
  'tempo',
]);

const CMDB_SOURCES = new Set([
  'cmdb',
  'manual',
  'inventory',
  'admin',
  'operator',
]);

const DEFAULT_CONFIDENCE: Record<RelationshipSourceGroup, number> = {
  collector: 0.55,
  otel: 0.6,
  cmdb: 0.7,
  inferred: 0.2,
};

export function relationshipSourceGroup(
  source: string,
): RelationshipSourceGroup {
  const key = source.trim().toLowerCase();
  if (COLLECTOR_SOURCES.has(key)) return 'collector';
  if (OTEL_SOURCES.has(key)) return 'otel';
  if (CMDB_SOURCES.has(key)) return 'cmdb';
  return 'inferred';
}

export function edgeConfidence(fact: RelationshipFact): number {
  if (fact.confidence != null && Number.isFinite(fact.confidence)) {
    return Math.min(1, Math.max(0, fact.confidence));
  }
  return DEFAULT_CONFIDENCE[relationshipSourceGroup(fact.source)];
}

function hopKey(fact: RelationshipFact): string {
  return `${fact.fromKey}\0${fact.toKey}\0${fact.relation}`;
}

/**
 * Combina fuentes de la misma arista (from, to, relation).
 * Telemetría del recolector + OpenTelemetry + CMDB manual puntúa más
 * que una sola relación débil inferida (noisy-OR + bonus de diversidad).
 */
export function aggregateHopSources(facts: RelationshipFact[]): number {
  if (facts.length === 0) return 0;
  const groups = new Set<RelationshipSourceGroup>();
  let miss = 1;
  for (const fact of facts) {
    groups.add(relationshipSourceGroup(fact.source));
    miss *= 1 - edgeConfidence(fact);
  }
  let score = 1 - miss;
  if (
    groups.has('collector') &&
    groups.has('otel') &&
    groups.has('cmdb')
  ) {
    score = Math.min(1, score + 0.08);
  }
  return roundScore(score);
}

/** Confianza de un camino: media geométrica de los hops (el eslabón débil pesa). */
export function aggregatePathConfidence(hopScores: number[]): number {
  if (hopScores.length === 0) return 0;
  const logSum = hopScores.reduce(
    (total, value) => total + Math.log(Math.max(value, 0.01)),
    0,
  );
  return roundScore(Math.exp(logSum / hopScores.length));
}

export function aggregateRelationshipConfidence(
  facts: RelationshipFact[],
): number {
  if (facts.length === 0) return 0;
  const hops = new Map<string, RelationshipFact[]>();
  for (const fact of facts) {
    const key = hopKey(fact);
    const list = hops.get(key) ?? [];
    list.push(fact);
    hops.set(key, list);
  }
  const hopScores = [...hops.values()].map(aggregateHopSources);
  return hops.size === 1
    ? hopScores[0]
    : aggregatePathConfidence(hopScores);
}
