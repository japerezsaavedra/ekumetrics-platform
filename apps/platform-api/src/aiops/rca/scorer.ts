import { createRcaEvidence, type RcaEvidence } from '../types/rca-evidence';
import type { RcaScoreWeights, RcaSubscores } from '../types/root-cause-candidate';
import {
  ancestorDistances,
  pickClosest,
  shortestPath,
  walkDirected,
  type TopologyWalkEdge,
} from '../topology-walk';
import {
  CAUSALITY_DISCLAIMER,
  NEUTRAL_DEPENDENCY_SCORE,
  NEUTRAL_HISTORICAL_SCORE,
  NEUTRAL_TEMPORAL_SCORE,
  RCA_ALGORITHM,
  SERVICE_KINDS,
} from './constants';
import { buildHypothesis, formatDelta } from './explain';
import type {
  RcaEntityInput,
  RcaGraphEdge,
  RcaObservation,
  RcaScoreContext,
  ScoredRcaCandidate,
} from './types';

export function roundRcaScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
}

export function combineRcaScore(
  subscores: RcaSubscores,
  weights: RcaScoreWeights,
): number {
  return roundRcaScore(
    weights.temporal * subscores.temporalScore +
      weights.topology * subscores.topologyScore +
      weights.anomaly * subscores.anomalyScore +
      weights.dependency * subscores.dependencyScore +
      weights.historical * subscores.historicalScore,
  );
}

export function scoreRcaCandidates(
  context: RcaScoreContext,
): ScoredRcaCandidate[] {
  const affected = unique(context.affectedEntityIds);
  const edges = context.edges.map(toWalkEdge);
  const commonAncestorKey = commonAncestor(affected, edges, context.hops);
  const serviceKeys = new Set(
    context.entities
      .filter((item) => SERVICE_KINDS.has((item.entityType ?? '').toLowerCase()))
      .map((item) => item.entityId),
  );
  const scored = context.entities.map((entity) =>
    scoreOne({
      entity,
      context,
      affected,
      edges,
      commonAncestorKey,
      serviceKeys,
    }),
  );
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }
    return left.entityId.localeCompare(right.entityId);
  });
  return scored.map((item, index) => ({
    ...item,
    hypothesis: rebuildHypothesisLead(item.hypothesis, item.name, index === 0),
  }));
}

function rebuildHypothesisLead(
  hypothesis: string,
  name: string,
  leading: boolean,
): string {
  const lead = leading
    ? `${name} es el candidato principal de causa raíz`
    : `${name} es un candidato de causa raíz`;
  return hypothesis.replace(/^.+? de causa raíz/, lead);
}

function scoreOne(input: {
  entity: RcaEntityInput;
  context: RcaScoreContext;
  affected: string[];
  edges: TopologyWalkEdge[];
  commonAncestorKey: string | null;
  serviceKeys: Set<string>;
}): ScoredRcaCandidate {
  const { entity, context, affected, edges, commonAncestorKey } = input;
  const descendants = new Set(
    walkDirected(entity.entityId, edges, context.hops, 'dependents'),
  );
  const ancestors = new Set(
    walkDirected(entity.entityId, edges, context.hops, 'dependencies'),
  );
  const directedDependents = affected.filter(
    (key) => key !== entity.entityId && descendants.has(key),
  );
  const directedDependencies = affected.filter(
    (key) => key !== entity.entityId && ancestors.has(key),
  );
  const distances = pathDistances(
    entity.entityId,
    affected,
    edges,
    context.hops,
  );
  const temporal = scoreTemporal({
    entity,
    directedDependents,
    context,
  });
  const topology = scoreTopology({
    entityId: entity.entityId,
    affected,
    directedDependents,
    distances,
    commonAncestorKey,
    hops: context.hops,
  });
  const anomaly = scoreAnomaly(entity);
  const dependency = scoreDependency({
    directedDependents,
    directedDependencies,
  });
  const historical = scoreHistorical(entity);
  const subscores: RcaSubscores = {
    temporalScore: temporal.score,
    topologyScore: topology.score,
    anomalyScore: anomaly.score,
    dependencyScore: dependency.score,
    historicalScore: historical.score,
  };
  const score = combineRcaScore(subscores, context.weights);
  const confidence = scoreConfidence(score, subscores, entity.historicalAvailable);
  const upstreamAnomaly = context.entities.some(
    (item) =>
      item.entityId !== entity.entityId &&
      ancestors.has(item.entityId) &&
      item.anomaly != null,
  );
  const downstreamName = primaryDownstreamName(
    directedDependents,
    context.entities,
  );
  const evidence = [
    temporal.evidence,
    topology.evidence,
    anomaly.evidence,
    dependency.evidence,
    historical.evidence,
    causalityEvidence(),
  ];
  const hypothesis = buildHypothesis({
    name: entity.name,
    rankWouldBeFirst: true,
    score,
    confidence,
    algorithm: RCA_ALGORITHM,
    anomalyScore: entity.anomaly?.score,
    anomalyMetric: entity.anomaly?.metric,
    anomalySummary: entity.anomaly?.summary,
    deltaMs: temporal.deltaMs,
    downstreamName,
    dependentCount: directedDependents.length,
    isCommonAncestor: commonAncestorKey === entity.entityId,
    upstreamAnomaly,
    role: dependency.role,
  });
  const affectedServices = affected.filter((key) => input.serviceKeys.has(key));
  return {
    entityId: entity.entityId,
    entityType: entity.entityType,
    name: entity.name,
    score,
    confidence,
    subscores,
    weights: { ...context.weights },
    evidence,
    hypothesis,
    affectedEntities: [...affected],
    affectedServices:
      affectedServices.length > 0
        ? affectedServices
        : affected.filter((key) => key !== entity.entityId),
    firstObservedAt: entity.firstObservedAt,
    algorithm: RCA_ALGORITHM,
  };
}

function scoreTemporal(input: {
  entity: RcaEntityInput;
  directedDependents: string[];
  context: RcaScoreContext;
}): { score: number; deltaMs?: number; evidence: RcaEvidence } {
  const factsBase = {
    algorithm: RCA_ALGORITHM,
    temporalIsNotCausal: true,
  };
  if (input.directedDependents.length === 0) {
    return {
      score: NEUTRAL_TEMPORAL_SCORE,
      evidence: evidenceOf(
        'event',
        `Sin dependientes afectados aguas abajo; no hay señal temporal causal. ${CAUSALITY_DISCLAIMER}`,
        NEUTRAL_TEMPORAL_SCORE,
        input.entity.entityId,
        { ...factsBase, reason: 'no_downstream_dependency' },
      ),
    };
  }
  const candidateTs = timestampOf(input.entity.entityId, input.context);
  const downstreamTs = minTimestamp(input.directedDependents, input.context);
  if (candidateTs == null || downstreamTs == null) {
    return {
      score: NEUTRAL_TEMPORAL_SCORE,
      evidence: evidenceOf(
        'event',
        `Faltan marcas de tiempo para ordenar candidato y fallos aguas abajo. ${CAUSALITY_DISCLAIMER}`,
        NEUTRAL_TEMPORAL_SCORE,
        input.entity.entityId,
        { ...factsBase, reason: 'missing_timestamps' },
      ),
    };
  }
  const deltaMs = downstreamTs - candidateTs;
  if (deltaMs > 0) {
    const score = roundRcaScore(0.65 + 0.35 * Math.min(1, deltaMs / 120_000));
    return {
      score,
      deltaMs,
      evidence: evidenceOf(
        'event',
        `La señal del candidato comenzó ${formatDelta(deltaMs)} antes que el fallo aguas abajo. ${CAUSALITY_DISCLAIMER}`,
        score,
        input.entity.entityId,
        { ...factsBase, deltaMs, direction: 'before_downstream' },
      ),
    };
  }
  if (deltaMs === 0) {
    return {
      score: NEUTRAL_TEMPORAL_SCORE,
      deltaMs,
      evidence: evidenceOf(
        'event',
        `Misma marca de tiempo que el fallo aguas abajo; no hay precedencia. ${CAUSALITY_DISCLAIMER}`,
        NEUTRAL_TEMPORAL_SCORE,
        input.entity.entityId,
        { ...factsBase, deltaMs, direction: 'simultaneous' },
      ),
    };
  }
  const score = roundRcaScore(Math.max(0.1, 0.35 + deltaMs / 120_000));
  return {
    score,
    deltaMs,
    evidence: evidenceOf(
      'event',
      `La señal del candidato es ${formatDelta(-deltaMs)} posterior al fallo aguas abajo; peor señal temporal. ${CAUSALITY_DISCLAIMER}`,
      score,
      input.entity.entityId,
      { ...factsBase, deltaMs, direction: 'after_downstream' },
    ),
  };
}

function scoreTopology(input: {
  entityId: string;
  affected: string[];
  directedDependents: string[];
  distances: Map<string, number>;
  commonAncestorKey: string | null;
  hops: number;
}): { score: number; evidence: RcaEvidence } {
  const isCommonAncestor = input.commonAncestorKey === input.entityId;
  const reachable = [...input.distances.entries()].filter(
    ([, distance]) => Number.isFinite(distance),
  );
  if (
    !isCommonAncestor &&
    input.directedDependents.length === 0 &&
    reachable.length === 0
  ) {
    return {
      score: 0,
      evidence: evidenceOf(
        'topology',
        'Sin camino de topología hacia el resto de entidades afectadas; no se infiere causa por vecindad temporal',
        0,
        input.entityId,
        {
          algorithm: RCA_ALGORITHM,
          hops: input.hops,
          related: false,
        },
      ),
    };
  }
  const others = Math.max(input.affected.length - 1, 1);
  const blast = input.directedDependents.length / others;
  const distScore =
    reachable.length === 0
      ? 0
      : reachable.reduce((sum, [, distance]) => {
          const hopsAway = Math.max(0, distance - 1);
          return sum + Math.max(0, 1 - hopsAway / input.hops);
        }, 0) / reachable.length;
  let score = 0;
  if (isCommonAncestor) score += 0.4;
  else if (input.directedDependents.length > 0) score += 0.25;
  else if (reachable.length > 0) score += 0.1;
  score += 0.35 * blast;
  score += 0.25 * distScore;
  const rounded = roundRcaScore(score);
  return {
    score: rounded,
    evidence: evidenceOf(
      'topology',
      isCommonAncestor
        ? `Ancestro común del conjunto afectado; radio de explosión ${input.directedDependents.length} dependiente(s)`
        : input.directedDependents.length > 0
          ? `Camino de dependencia hacia ${input.directedDependents.length} entidad(es) afectada(s)`
          : `Camino no dirigido hacia entidades afectadas (señal débil; no implica causalidad)`,
      rounded,
      input.entityId,
      {
        algorithm: RCA_ALGORITHM,
        isCommonAncestor,
        dependentCount: input.directedDependents.length,
        hops: input.hops,
      },
    ),
  };
}

function scoreAnomaly(entity: RcaEntityInput): {
  score: number;
  evidence: RcaEvidence;
} {
  const anomaly = entity.anomaly;
  if (!anomaly) {
    return {
      score: 0,
      evidence: evidenceOf(
        'metric',
        'Sin AnomalyResult para esta entidad; no se fabrica anomalía',
        0,
        entity.entityId,
        { algorithm: RCA_ALGORITHM, available: false },
      ),
    };
  }
  const confidence = clamp01(anomaly.confidence);
  const raw = clamp01(anomaly.score);
  const score = roundRcaScore(raw * (0.5 + 0.5 * confidence));
  const metric = anomaly.metric ? ` de ${anomaly.metric}` : '';
  return {
    score,
    evidence: evidenceOf(
      'metric',
      `Anomalía${metric} score ${raw.toFixed(2)} (confianza del detector ${confidence.toFixed(2)})`,
      score,
      entity.entityId,
      {
        algorithm: RCA_ALGORITHM,
        anomalyScore: raw,
        detectorConfidence: confidence,
        detector: anomaly.detector ?? 'anomaly-port',
        metric: anomaly.metric ?? null,
      },
      confidence,
    ),
  };
}

function scoreDependency(input: {
  directedDependents: string[];
  directedDependencies: string[];
}): {
  score: number;
  role: 'dependency' | 'dependent' | 'unknown';
  evidence: RcaEvidence;
} {
  if (
    input.directedDependents.length === 0 &&
    input.directedDependencies.length === 0
  ) {
    return {
      score: NEUTRAL_DEPENDENCY_SCORE,
      role: 'unknown',
      evidence: evidenceOf(
        'topology',
        'Sin dirección de dependencia hacia el resto del incidente; no se asume causalidad',
        NEUTRAL_DEPENDENCY_SCORE,
        undefined,
        { algorithm: RCA_ALGORITHM, role: 'unknown' },
      ),
    };
  }
  if (
    input.directedDependents.length > 0 &&
    input.directedDependencies.length === 0
  ) {
    const score = roundRcaScore(
      Math.min(1, 0.55 + 0.15 * input.directedDependents.length),
    );
    return {
      score,
      role: 'dependency',
      evidence: evidenceOf(
        'topology',
        `Fallo en una dependencia: ${input.directedDependents.length} entidad(es) afectada(s) dependen de este candidato`,
        score,
        undefined,
        {
          algorithm: RCA_ALGORITHM,
          role: 'dependency',
          dependentCount: input.directedDependents.length,
        },
      ),
    };
  }
  if (input.directedDependents.length === 0) {
    return {
      score: 0.2,
      role: 'dependent',
      evidence: evidenceOf(
        'topology',
        'Fallo en un dependiente (hoja): puntúa menos que una dependencia aguas arriba',
        0.2,
        undefined,
        {
          algorithm: RCA_ALGORITHM,
          role: 'dependent',
          dependencyCount: input.directedDependencies.length,
        },
      ),
    };
  }
  return {
    score: 0.45,
    role: 'dependency',
    evidence: evidenceOf(
      'topology',
      'Posición mixta en la cadena (tiene dependientes y dependencias afectadas)',
      0.45,
      undefined,
      { algorithm: RCA_ALGORITHM, role: 'mixed' },
    ),
  };
}

function scoreHistorical(entity: RcaEntityInput): {
  score: number;
  evidence: RcaEvidence;
} {
  if (!entity.historicalAvailable) {
    return {
      score: NEUTRAL_HISTORICAL_SCORE,
      evidence: evidenceOf(
        'finding',
        `Sin evidencia histórica para este tenant/entidad; historicalScore neutro (${NEUTRAL_HISTORICAL_SCORE})`,
        NEUTRAL_HISTORICAL_SCORE,
        entity.entityId,
        {
          algorithm: RCA_ALGORITHM,
          available: false,
          priorMatches: entity.historicalMatches ?? 0,
          fabricated: false,
        },
      ),
    };
  }
  const score = roundRcaScore(clamp01(entity.historicalScore));
  return {
    score,
    evidence: evidenceOf(
      'finding',
      entity.historicalSummary ??
        `Evidencia histórica del mismo tenant: ${entity.historicalMatches ?? 0} coincidencia(s)`,
      score,
      entity.entityId,
      {
        algorithm: RCA_ALGORITHM,
        available: true,
        priorMatches: entity.historicalMatches ?? 0,
      },
    ),
  };
}

function scoreConfidence(
  score: number,
  subscores: RcaSubscores,
  historicalAvailable: boolean,
): number {
  let signals = 0;
  if (subscores.topologyScore > 0) signals += 1;
  if (subscores.dependencyScore !== NEUTRAL_DEPENDENCY_SCORE) signals += 1;
  if (subscores.anomalyScore > 0) signals += 1;
  if (subscores.temporalScore !== NEUTRAL_TEMPORAL_SCORE) signals += 1;
  if (historicalAvailable) signals += 1;
  const topologyBoost = subscores.topologyScore > 0.5 ? 0.15 : 0;
  return roundRcaScore(
    Math.min(1, 0.35 * score + 0.12 * signals + topologyBoost),
  );
}

function causalityEvidence(): RcaEvidence {
  return evidenceOf(
    'finding',
    CAUSALITY_DISCLAIMER,
    0,
    undefined,
    { algorithm: RCA_ALGORITHM, temporalIsNotCausal: true },
  );
}

function evidenceOf(
  kind: RcaEvidence['kind'],
  summary: string,
  score: number,
  entityKey: string | undefined,
  facts: Record<string, unknown>,
  confidence = score,
): RcaEvidence {
  return createRcaEvidence({
    kind,
    summary,
    confidence: clamp01(confidence),
    entityKey,
    facts: { ...facts, score, algorithm: RCA_ALGORITHM },
  });
}

function timestampOf(
  entityId: string,
  context: RcaScoreContext,
): number | null {
  const entity = context.entities.find((item) => item.entityId === entityId);
  if (entity?.firstObservedAt) return entity.firstObservedAt.getTime();
  const times = context.observations
    .filter((item) => item.entityId === entityId && item.observedAt)
    .map((item) => item.observedAt!.getTime());
  if (times.length === 0) return null;
  return Math.min(...times);
}

function minTimestamp(
  entityIds: string[],
  context: RcaScoreContext,
): number | null {
  const times = entityIds
    .map((id) => timestampOf(id, context))
    .filter((value): value is number => value != null);
  if (times.length === 0) return null;
  return Math.min(...times);
}

function pathDistances(
  from: string,
  affected: string[],
  edges: TopologyWalkEdge[],
  hops: number,
): Map<string, number> {
  const distances = new Map<string, number>();
  for (const other of affected) {
    if (other === from) continue;
    const path = shortestPath(from, other, edges, hops);
    if (path) distances.set(other, path.length - 1);
  }
  return distances;
}

function commonAncestor(
  affected: string[],
  edges: TopologyWalkEdge[],
  hops: number,
): string | null {
  const uniqueKeys = unique(affected);
  if (uniqueKeys.length === 0) return null;
  if (uniqueKeys.length === 1) return uniqueKeys[0];
  const distances = uniqueKeys.map((key) =>
    ancestorDistances(key, edges, hops),
  );
  const candidates = [...distances[0].keys()].filter((key) =>
    distances.every((map) => map.has(key)),
  );
  return pickClosest(candidates, distances);
}

function primaryDownstreamName(
  dependents: string[],
  entities: RcaEntityInput[],
): string | undefined {
  if (dependents.length === 0) return undefined;
  const match = entities.find((item) => item.entityId === dependents[0]);
  return match?.name ?? dependents[0];
}

function toWalkEdge(edge: RcaGraphEdge): TopologyWalkEdge {
  return {
    fromKey: edge.fromKey,
    toKey: edge.toKey,
    relation: edge.relation,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
