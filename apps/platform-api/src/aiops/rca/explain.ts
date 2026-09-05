import { RCA_ALGORITHM } from './constants';

export function formatDelta(ms: number): string {
  const seconds = Math.max(0, Math.round(Math.abs(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

export function buildHypothesis(input: {
  name: string;
  rankWouldBeFirst: boolean;
  score: number;
  confidence: number;
  algorithm: string;
  anomalyScore?: number;
  anomalyMetric?: string;
  anomalySummary?: string;
  deltaMs?: number;
  downstreamName?: string;
  dependentCount: number;
  isCommonAncestor: boolean;
  upstreamAnomaly: boolean;
  role: 'dependency' | 'dependent' | 'unknown';
}): string {
  const parts: string[] = [];
  if (input.anomalyScore != null) {
    const metric = input.anomalyMetric ?? input.anomalySummary ?? 'métrica';
    parts.push(`anomalía de ${metric} score ${input.anomalyScore.toFixed(2)}`);
  }
  if (input.deltaMs != null && input.deltaMs > 0 && input.downstreamName) {
    parts.push(
      `la anomalía comenzó ${formatDelta(input.deltaMs)} antes que los errores de ${input.downstreamName}`,
    );
  } else if (input.deltaMs != null && input.deltaMs > 0) {
    parts.push(
      `la señal comenzó ${formatDelta(input.deltaMs)} antes que los fallos aguas abajo`,
    );
  }
  if (input.dependentCount > 0) {
    parts.push(
      `la topología muestra ${input.dependentCount} ${
        input.dependentCount === 1
          ? 'entidad impactada que depende'
          : 'entidades impactadas que dependen'
      } de esta ${roleLabel(input.role)}`,
    );
  } else if (input.isCommonAncestor) {
    parts.push('es ancestro común del conjunto afectado en el grafo');
  }
  if (!input.upstreamAnomaly && input.role === 'dependency') {
    parts.push('no se detectó anomalía aguas arriba');
  }
  const lead =
    input.rankWouldBeFirst
      ? `${input.name} es el candidato principal de causa raíz`
      : `${input.name} es un candidato de causa raíz`;
  const because =
    parts.length > 0 ? ` porque: ${parts.join('; ')}` : '';
  return `${lead}${because}. Score ${input.score.toFixed(2)}, confianza ${input.confidence.toFixed(2)}, algoritmo ${input.algorithm ?? RCA_ALGORITHM}.`;
}

function roleLabel(role: 'dependency' | 'dependent' | 'unknown'): string {
  if (role === 'dependency') return 'dependencia';
  if (role === 'dependent') return 'entidad dependiente';
  return 'entidad';
}
