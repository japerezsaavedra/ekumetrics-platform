import { walk, type GraphLink } from './graph-walk';
import type { CorrelationWeights } from './correlation-weights';
import type {
  ClusterCorrelation,
  CorrelateAlert,
  CorrelationEvidence,
  CorrelationScore,
} from './correlation-types';

export const SHARED_LABEL_KEYS = [
  'app',
  'application',
  'job',
  'service',
  'service_name',
  'alertname',
  'instance',
  'env',
  'environment',
  'cluster',
  'namespace',
  'workload',
] as const;

const CAUSALITY_STATEMENT =
  'La coincidencia en el tiempo no demuestra que una alerta cause la otra.';

export type HistoricalSignal = {
  priorSameCluster: number;
  priorSimilarCause: number;
};

export type ClusterItem = {
  alert: CorrelateAlert;
  nodeKey: string | null;
};

export function hopDistance(
  left: string,
  right: string,
  edges: GraphLink[],
  hops: number,
): number | null {
  if (left === right) return 0;
  for (let distance = 1; distance <= hops; distance += 1) {
    if (walk(left, edges, distance).has(right)) return distance;
  }
  return null;
}

export function roundScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
}

export function sharedLabels(
  alerts: CorrelateAlert[],
): Array<{ key: string; value: string }> {
  if (alerts.length < 2) return [];
  const shared: Array<{ key: string; value: string }> = [];
  for (const key of SHARED_LABEL_KEYS) {
    const values = alerts
      .map((alert) => (alert.labels?.[key] ?? '').trim())
      .filter(Boolean);
    if (values.length < 2) continue;
    const first = values[0];
    if (values.every((value) => value === first)) {
      shared.push({ key, value: first });
    }
  }
  return shared;
}

export function scoreCluster(input: {
  items: ClusterItem[];
  edges: GraphLink[];
  windowMs: number;
  hops: number;
  weights: CorrelationWeights;
  historical: HistoricalSignal;
}): ClusterCorrelation {
  const temporal = scoreTemporal(input.items, input.windowMs);
  const entity = scoreEntity(input.items);
  const topology = scoreTopology(input.items, input.edges, input.hops);
  const label = scoreLabel(input.items);
  const historical = scoreHistorical(input.historical);
  const components = {
    temporalScore: temporal.score,
    entityScore: entity.score,
    topologyScore: topology.score,
    labelScore: label.score,
    historicalScore: historical.score,
  };
  const total = roundScore(
    input.weights.temporal * components.temporalScore +
      input.weights.entity * components.entityScore +
      input.weights.topology * components.topologyScore +
      input.weights.label * components.labelScore +
      input.weights.historical * components.historicalScore,
  );
  const details: CorrelationEvidence[] = [
    temporal.evidence,
    entity.evidence,
    topology.evidence,
    label.evidence,
    historical.evidence,
    {
      kind: 'causality',
      statement: CAUSALITY_STATEMENT,
      score: 0,
      details: { temporalIsNotCausal: true },
    },
  ];
  const score: CorrelationScore = {
    total,
    ...components,
    weights: { ...input.weights },
  };
  return {
    score: score.total,
    components,
    weights: score.weights,
    evidence: details.map((item) => item.statement),
    details,
  };
}

function scoreTemporal(
  items: ClusterItem[],
  windowMs: number,
): { score: number; evidence: CorrelationEvidence } {
  const times = items
    .map((item) =>
      item.alert.startsAt ? Date.parse(item.alert.startsAt) : Number.NaN,
    )
    .filter((value) => Number.isFinite(value));
  const windowMin = Math.round(windowMs / 60_000);
  if (times.length < 2) {
    return {
      score: 0.5,
      evidence: {
        kind: 'temporal',
        statement: `Ventana temporal de ${windowMin} min aplicada por defecto (faltan marcas de tiempo). ${CAUSALITY_STATEMENT}`,
        score: 0.5,
        details: { incompleteTimestamps: true, windowMs },
      },
    };
  }
  const spanMs = Math.max(...times) - Math.min(...times);
  const score = roundScore(1 - spanMs / windowMs);
  return {
    score,
    evidence: {
      kind: 'temporal',
      statement: `Ocurrieron a ${formatDelta(spanMs)} de diferencia (ventana de ${windowMin} min). ${CAUSALITY_STATEMENT}`,
      score,
      details: { spanMs, windowMs },
    },
  };
}

function scoreEntity(items: ClusterItem[]): {
  score: number;
  evidence: CorrelationEvidence;
} {
  const keys = items
    .map((item) => item.nodeKey)
    .filter((key): key is string => Boolean(key));
  const mode = mostCommon(keys);
  if (mode && keys.length === items.length && new Set(keys).size === 1) {
    return {
      score: 1,
      evidence: {
        kind: 'entity',
        statement: `Misma entidad: ${mode}`,
        score: 1,
        details: { entityKey: mode },
      },
    };
  }
  if (mode && keys.length >= 2) {
    const score = roundScore(
      keys.filter((key) => key === mode).length / items.length,
    );
    return {
      score,
      evidence: {
        kind: 'entity',
        statement: `Entidad dominante: ${mode} (${keys.filter((key) => key === mode).length} de ${items.length} alertas)`,
        score,
        details: { entityKey: mode },
      },
    };
  }
  const hints = items
    .map((item) => item.alert.nodeHint?.trim() ?? '')
    .filter(Boolean);
  const hintMode = mostCommon(hints);
  if (hintMode && hints.length >= 2 && new Set(hints).size === 1) {
    return {
      score: 0.7,
      evidence: {
        kind: 'entity',
        statement: `Mismo hint de activo: ${hintMode}`,
        score: 0.7,
        details: { nodeHint: hintMode },
      },
    };
  }
  return {
    score: 0,
    evidence: {
      kind: 'entity',
      statement: 'Entidades distintas o no resueltas en el grafo',
      score: 0,
    },
  };
}

function scoreTopology(
  items: ClusterItem[],
  edges: GraphLink[],
  hops: number,
): { score: number; evidence: CorrelationEvidence } {
  const keys = [
    ...new Set(items.map((item) => item.nodeKey).filter(Boolean)),
  ] as string[];
  if (keys.length >= 2) {
    const distances: number[] = [];
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        const distance = hopDistance(keys[i], keys[j], edges, hops);
        if (distance != null) distances.push(distance);
      }
    }
    if (distances.length === 0) {
      return {
        score: 0,
        evidence: {
          kind: 'topology',
          statement: `Sin camino de dependencia dentro de ${hops} hops`,
          score: 0,
          details: { hops },
        },
      };
    }
    const minDistance = Math.min(...distances);
    const avg =
      distances.reduce((sum, value) => sum + value, 0) / distances.length;
    const score = roundScore(1 - (avg - (minDistance === 0 ? 0 : 1)) / hops);
    return {
      score,
      evidence: {
        kind: 'topology',
        statement:
          minDistance === 0
            ? 'Misma entidad en el grafo (distancia 0)'
            : `Camino de dependencia a distancia ${minDistance}`,
        score,
        details: { minDistance, hops },
      },
    };
  }
  if (keys.length === 1) {
    return {
      score: 0.4,
      evidence: {
        kind: 'topology',
        statement: 'Un solo nodo resuelto; no hay camino que comparar',
        score: 0.4,
        details: { entityKey: keys[0] },
      },
    };
  }
  return {
    score: 0,
    evidence: {
      kind: 'topology',
      statement:
        'Sin nodos en el grafo; el agrupado es por sitio y ventana, no por topología',
      score: 0,
    },
  };
}

function scoreLabel(items: ClusterItem[]): {
  score: number;
  evidence: CorrelationEvidence;
} {
  const shared = sharedLabels(items.map((item) => item.alert));
  if (shared.length === 0) {
    return {
      score: 0,
      evidence: {
        kind: 'label',
        statement: 'Sin etiquetas compartidas entre las alertas',
        score: 0,
      },
    };
  }
  const score = roundScore(Math.min(1, shared.length / 3));
  const preview = shared
    .slice(0, 3)
    .map((item) => `${item.key}=${item.value}`)
    .join(', ');
  return {
    score,
    evidence: {
      kind: 'label',
      statement: `Etiqueta compartida: ${preview}`,
      score,
      details: { sharedCount: shared.length },
    },
  };
}

function scoreHistorical(historical: HistoricalSignal): {
  score: number;
  evidence: CorrelationEvidence;
} {
  const prior = historical.priorSameCluster + historical.priorSimilarCause;
  if (prior <= 0) {
    return {
      score: 0,
      evidence: {
        kind: 'historical',
        statement: 'Sin incidentes previos del mismo tenant con este patrón',
        score: 0,
        details: { priorSameCluster: 0, priorSimilarCause: 0 },
      },
    };
  }
  const score = roundScore(Math.min(1, 0.5 + prior * 0.15));
  return {
    score,
    evidence: {
      kind: 'historical',
      statement: `Patrón recurrente: ${prior} incidentes previos del mismo tenant`,
      score,
      details: {
        priorSameCluster: historical.priorSameCluster,
        priorSimilarCause: historical.priorSimilarCause,
      },
    },
  };
}

function mostCommon(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function formatDelta(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} segundos`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minutos`;
}
