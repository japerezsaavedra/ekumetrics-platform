import { isConfidence, type RcaEvidence } from './rca-evidence';

export const ROOT_CAUSE_STATUSES = [
  'PROPOSED',
  'ACCEPTED',
  'REJECTED',
  'SUPERSEDED',
] as const;

export type RootCauseCandidateStatus = (typeof ROOT_CAUSE_STATUSES)[number];

export const ROOT_CAUSE_SOURCES = [
  'deterministic_rca',
  'synthesis',
  'operator',
] as const;

export type RootCauseSource = (typeof ROOT_CAUSE_SOURCES)[number];

export type RcaSubscores = {
  temporalScore: number;
  topologyScore: number;
  anomalyScore: number;
  dependencyScore: number;
  historicalScore: number;
};

export type RcaScoreWeights = {
  temporal: number;
  topology: number;
  anomaly: number;
  dependency: number;
  historical: number;
};

/**
 * Hipótesis de causa raíz. Transitoria: no hay tabla Prisma.
 * Incident.causeKey|causeName|confidence siguen siendo caché de correlación.
 * Wave 2 añade score, subscores y entidades afectadas (todo opcional para no romper wave 1).
 */
export type RootCauseCandidate = {
  id: string;
  tenantId: string;
  incidentId: string;
  investigationId?: string;
  rank: number;
  entityKey?: string;
  entityId?: string;
  entityType?: string;
  hypothesis: string;
  /** Score final ponderado 0..1. Distinto de confidence (calidad de evidencia). */
  score?: number;
  confidence: number;
  status: RootCauseCandidateStatus;
  evidence: RcaEvidence[];
  source: RootCauseSource;
  algorithm?: string;
  findingIds: string[];
  affectedEntities?: string[];
  affectedServices?: string[];
  firstObservedAt?: Date;
  subscores?: RcaSubscores;
  weights?: RcaScoreWeights;
  createdAt: Date;
  acceptedAt?: Date;
  rejectedAt?: Date;
  acceptedBy?: string;
};

export function createRootCauseCandidate(
  input: Omit<RootCauseCandidate, 'id' | 'status' | 'createdAt'> & {
    id?: string;
    status?: RootCauseCandidateStatus;
    createdAt?: Date;
  },
): RootCauseCandidate {
  if (!input.tenantId) {
    throw new Error('RootCauseCandidate.tenantId es obligatorio.');
  }
  if (!input.incidentId) {
    throw new Error('RootCauseCandidate.incidentId es obligatorio.');
  }
  const hypothesis = input.hypothesis.trim();
  if (!hypothesis) {
    throw new Error('RootCauseCandidate.hypothesis es obligatorio.');
  }
  if (!isConfidence(input.confidence)) {
    throw new Error('RootCauseCandidate.confidence debe estar en [0, 1].');
  }
  if (!input.evidence.length) {
    throw new Error(
      'RootCauseCandidate requiere evidencia estructurada (evidence-first).',
    );
  }
  if (!Number.isInteger(input.rank) || input.rank < 1) {
    throw new Error('RootCauseCandidate.rank debe ser un entero >= 1.');
  }
  return {
    id: input.id ?? `rcc-${input.incidentId}-${input.rank}`,
    tenantId: input.tenantId,
    incidentId: input.incidentId,
    investigationId: input.investigationId,
    rank: input.rank,
    entityKey: input.entityKey ?? input.entityId,
    entityId: input.entityId ?? input.entityKey,
    entityType: input.entityType,
    hypothesis,
    score: input.score,
    confidence: input.confidence,
    status: input.status ?? 'PROPOSED',
    evidence: input.evidence,
    source: input.source,
    algorithm: input.algorithm,
    findingIds: [...input.findingIds],
    affectedEntities: input.affectedEntities
      ? [...input.affectedEntities]
      : undefined,
    affectedServices: input.affectedServices
      ? [...input.affectedServices]
      : undefined,
    firstObservedAt: input.firstObservedAt,
    subscores: input.subscores ? { ...input.subscores } : undefined,
    weights: input.weights ? { ...input.weights } : undefined,
    createdAt: input.createdAt ?? new Date(),
    acceptedAt: input.acceptedAt,
    rejectedAt: input.rejectedAt,
    acceptedBy: input.acceptedBy,
  };
}

export function acceptedCandidateCount(
  candidates: readonly RootCauseCandidate[],
): number {
  return candidates.filter((item) => item.status === 'ACCEPTED').length;
}

/**
 * A lo sumo un ACCEPTED por incidente. No toca Incident.status.
 */
export function acceptRootCauseCandidate(
  candidates: readonly RootCauseCandidate[],
  candidateId: string,
  actor: string,
  now = new Date(),
): RootCauseCandidate[] {
  const target = candidates.find((item) => item.id === candidateId);
  if (!target) {
    throw new Error('La hipótesis de causa raíz no existe.');
  }
  if (target.status !== 'PROPOSED') {
    throw new Error('Solo se acepta una hipótesis en estado PROPOSED.');
  }
  return candidates.map((item) => {
    if (item.id === candidateId) {
      return {
        ...item,
        status: 'ACCEPTED',
        acceptedAt: now,
        acceptedBy: actor,
      };
    }
    if (item.status === 'ACCEPTED' || item.status === 'PROPOSED') {
      return { ...item, status: 'SUPERSEDED', rejectedAt: now };
    }
    return item;
  });
}

export function assertSingleAccepted(
  candidates: readonly RootCauseCandidate[],
): void {
  const accepted = acceptedCandidateCount(candidates);
  if (accepted > 1) {
    throw new Error(
      'Como máximo una hipótesis ACCEPTED por incidente a la vez.',
    );
  }
}

export type ScoredRootCauseCandidate = RootCauseCandidate & {
  entityId: string;
  score: number;
  subscores: RcaSubscores;
  affectedEntities: string[];
  affectedServices: string[];
};

export function createScoredRootCauseCandidate(
  input: Omit<RootCauseCandidate, 'id' | 'status' | 'createdAt'> & {
    id?: string;
    status?: RootCauseCandidateStatus;
    createdAt?: Date;
    entityId: string;
    score: number;
    subscores: RcaSubscores;
    affectedEntities: string[];
    affectedServices: string[];
  },
): ScoredRootCauseCandidate {
  if (!isConfidence(input.score)) {
    throw new Error('ScoredRootCauseCandidate.score debe estar en [0, 1].');
  }
  for (const name of [
    'temporalScore',
    'topologyScore',
    'anomalyScore',
    'dependencyScore',
    'historicalScore',
  ] as const) {
    if (!isConfidence(input.subscores[name])) {
      throw new Error(
        `ScoredRootCauseCandidate.subscores.${name} debe estar en [0, 1].`,
      );
    }
  }
  const created = createRootCauseCandidate({
    ...input,
    entityKey: input.entityKey ?? input.entityId,
    entityId: input.entityId,
    subscores: { ...input.subscores },
    affectedEntities: [...input.affectedEntities],
    affectedServices: [...input.affectedServices],
  });
  return {
    ...created,
    entityId: input.entityId,
    score: input.score,
    subscores: { ...input.subscores },
    affectedEntities: [...input.affectedEntities],
    affectedServices: [...input.affectedServices],
  };
}
