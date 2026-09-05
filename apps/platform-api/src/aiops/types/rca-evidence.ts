export const RCA_EVIDENCE_KINDS = [
  'metric',
  'log',
  'trace',
  'topology',
  'event',
  'finding',
  'change',
] as const;

export type RcaEvidenceKind = (typeof RCA_EVIDENCE_KINDS)[number];

/**
 * Evidencia estructurada (transitoria). No se persiste como tabla propia:
 * viaja dentro de RootCauseCandidate o se copia a AgentFinding.evidence.
 */
export type RcaEvidence = {
  id: string;
  kind: RcaEvidenceKind;
  summary: string;
  confidence?: number;
  entityKey?: string;
  sourceRef?: string;
  facts: Record<string, unknown>;
  observedAt?: Date;
};

export function createRcaEvidence(
  input: Omit<RcaEvidence, 'id'> & { id?: string },
): RcaEvidence {
  const summary = input.summary.trim();
  if (!summary) {
    throw new Error('RcaEvidence.summary es obligatorio.');
  }
  if (input.confidence !== undefined && !isConfidence(input.confidence)) {
    throw new Error('RcaEvidence.confidence debe estar en [0, 1].');
  }
  return {
    id: input.id ?? `ev-${stableToken()}`,
    kind: input.kind,
    summary,
    confidence: input.confidence,
    entityKey: input.entityKey,
    sourceRef: input.sourceRef,
    facts: { ...input.facts },
    observedAt: input.observedAt,
  };
}

export function isConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function stableToken(): string {
  return Math.random().toString(36).slice(2, 10);
}
