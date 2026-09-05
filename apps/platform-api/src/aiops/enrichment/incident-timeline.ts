import {
  INCIDENT_ENRICHMENT_ALGORITHM,
  type TimelineEntry,
  type TimelineKind,
} from './incident-enrichment.types';

const KIND_ORDER: Record<TimelineKind, number> = {
  anomaly: 0,
  change: 1,
  alert: 2,
  error: 3,
  topology: 4,
};

const ALGORITHM = 'timeline_occurred_at';

/**
 * Orden estable para UI y RCA: occurredAt ASC, luego kind, luego summary.
 * Reasigna `sequence` 1..n.
 */
export function orderTimeline(
  entries: readonly TimelineEntry[],
): TimelineEntry[] {
  const sorted = [...entries].sort((left, right) => {
    const time = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
    if (Number.isFinite(time) && time !== 0) return time;
    const leftInvalid = Number.isFinite(Date.parse(left.occurredAt)) ? 0 : 1;
    const rightInvalid = Number.isFinite(Date.parse(right.occurredAt)) ? 0 : 1;
    if (leftInvalid !== rightInvalid) return leftInvalid - rightInvalid;
    const kind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    if (kind !== 0) return kind;
    return left.summary.localeCompare(right.summary);
  });
  return sorted.map((entry, index) => ({
    ...entry,
    sequence: index + 1,
    algorithm: entry.algorithm || ALGORITHM,
  }));
}

export function timelineEntry(input: {
  occurredAt: string;
  summary: string;
  kind: TimelineKind;
  entityKey?: string;
  source: string;
  score?: number;
  confidence?: number;
  evidence?: TimelineEntry['evidence'];
}): TimelineEntry {
  const summary = input.summary.trim();
  return {
    occurredAt: input.occurredAt,
    sequence: 0,
    summary,
    kind: input.kind,
    entityKey: input.entityKey,
    source: input.source,
    algorithm: ALGORITHM,
    score: input.score ?? 0.5,
    confidence: input.confidence ?? 0.5,
    evidence: input.evidence ?? [
      {
        kind: 'event',
        statement: summary,
        score: input.score ?? 0.5,
        confidence: input.confidence ?? 0.5,
        algorithm: ALGORITHM,
        source: input.source,
      },
    ],
  };
}

export function timelineAlgorithm(): string {
  return `${INCIDENT_ENRICHMENT_ALGORITHM}/${ALGORITHM}`;
}
