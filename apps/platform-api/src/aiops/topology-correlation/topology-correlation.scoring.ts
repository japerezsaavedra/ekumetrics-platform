import { roundScore } from '../correlation-score';
import type {
  ClusterCorrelation,
  CorrelationEvidence,
} from '../correlation-types';
import type { TopologyEntity } from '../topology.repository';
import type { RootCauseSuppressionConfig } from './topology-correlation.config';
import type {
  BlastRadius,
  BlastRadiusNode,
  DependencyPathScore,
  ImpactPropagation,
  PathDirection,
  PropagatedImpactNode,
  TopologyAlertItem,
} from './topology-correlation.types';

const SERVICE_KINDS = new Set([
  'service',
  'api',
  'endpoint',
  'k8s_service',
]);

const APPLICATION_KINDS = new Set([
  'application',
  'app',
  'workload',
  'deployment',
  'k8s_deployment',
  'k8s_pod',
]);

const INFRA_KINDS = new Set([
  'switch',
  'router',
  'gateway',
  'firewall',
  'network',
]);

const IMPACT_DECAY = 0.75;

export function sameCorrelationWindow(
  left?: string | null,
  right?: string | null,
  windowMs = 300_000,
): boolean {
  const a = left ? Date.parse(left) : Number.NaN;
  const b = right ? Date.parse(right) : Number.NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return Math.abs(a - b) <= windowMs;
}

export function clusterSiteId(cluster: TopologyAlertItem[]): string {
  return cluster[0]?.alert.siteId || '';
}

export function clusterNodeKeys(cluster: TopologyAlertItem[]): string[] {
  return [
    ...new Set(
      cluster.map((item) => item.nodeKey).filter((key): key is string => Boolean(key)),
    ),
  ];
}

export function clusterWindowOverlap(
  left: TopologyAlertItem[],
  right: TopologyAlertItem[],
  windowMs: number,
): boolean {
  if (clusterSiteId(left) !== clusterSiteId(right)) return false;
  for (const a of left) {
    for (const b of right) {
      if (sameCorrelationWindow(a.alert.startsAt, b.alert.startsAt, windowMs)) {
        return true;
      }
    }
  }
  return false;
}

export function scoreDependencyPath(input: {
  fromKey: string;
  toKey: string;
  distance: number | null;
  direction: PathDirection;
  hops: number;
  relationshipConfidence: number;
}): DependencyPathScore {
  const confidence = Math.min(1, Math.max(0, input.relationshipConfidence));
  if (
    input.direction === 'none' ||
    input.distance == null ||
    input.distance < 0
  ) {
    return {
      fromKey: input.fromKey,
      toKey: input.toKey,
      distance: input.distance,
      direction: 'none',
      relationshipConfidence: 0,
      topologyScore: 0,
      causalScore: 0,
    };
  }
  const hops = Math.max(1, input.hops);
  const distanceScore = Math.max(0, 1 - Math.max(0, input.distance - 1) / hops);
  const topologyDirection =
    input.direction === 'upstream'
      ? 1
      : input.direction === 'downstream'
        ? 0.75
        : 0.5;
  const causalDirection =
    input.direction === 'upstream'
      ? 1
      : input.direction === 'downstream'
        ? 0.55
        : 0.35;
  return {
    fromKey: input.fromKey,
    toKey: input.toKey,
    distance: input.distance,
    direction: input.direction,
    relationshipConfidence: roundScore(confidence),
    topologyScore: roundScore(distanceScore * topologyDirection * confidence),
    causalScore: roundScore(distanceScore * causalDirection * confidence),
  };
}

export function scoreAlertPairTopology(
  pathScores: DependencyPathScore[],
): { topologyScore: number; causalScore: number } {
  if (pathScores.length === 0) {
    return { topologyScore: 0, causalScore: 0 };
  }
  const topologyScore = roundScore(
    pathScores.reduce((sum, item) => sum + item.topologyScore, 0) /
      pathScores.length,
  );
  const causalScore = roundScore(
    pathScores.reduce((sum, item) => sum + item.causalScore, 0) /
      pathScores.length,
  );
  return { topologyScore, causalScore };
}

/** Media de scores de caminos hacia un candidato de causa aguas arriba. */
export function scoreUpstreamCause(pathScores: DependencyPathScore[]): number {
  if (pathScores.length === 0) return 0;
  const upstream = pathScores.filter((item) => item.direction === 'upstream');
  const used = upstream.length > 0 ? upstream : pathScores;
  return roundScore(
    used.reduce((sum, item) => sum + item.causalScore, 0) / used.length,
  );
}

export function isServiceKind(kind: string): boolean {
  const key = kind.trim().toLowerCase();
  return SERVICE_KINDS.has(key) || key.includes('service');
}

export function isApplicationKind(kind: string): boolean {
  const key = kind.trim().toLowerCase();
  return APPLICATION_KINDS.has(key) || key.includes('application');
}

export function isInfraKind(kind: string): boolean {
  const key = kind.trim().toLowerCase();
  return INFRA_KINDS.has(key);
}

/** Prefiere un switch/router en alerta que cubra el cluster sobre el ancestro de cómputo. */
export function pickRootCauseKey(input: {
  ancestorKey: string | null;
  coveringInfraKeys: string[];
}): string | null {
  if (input.coveringInfraKeys.length > 0) return input.coveringInfraKeys[0];
  return input.ancestorKey;
}

export function toBlastNode(
  entity: Pick<TopologyEntity, 'entityKey' | 'kind' | 'name'>,
  distance: number,
): BlastRadiusNode {
  return {
    entityKey: entity.entityKey,
    kind: entity.kind,
    name: entity.name,
    distance,
  };
}

export function buildBlastRadius(input: {
  originKey: string;
  hops: number;
  direct: BlastRadiusNode[];
  indirect: BlastRadiusNode[];
}): BlastRadius {
  const impacted = [...input.direct, ...input.indirect];
  return {
    originKey: input.originKey,
    hops: input.hops,
    directDependents: input.direct,
    indirectDependents: input.indirect,
    affectedServices: impacted.filter((node) => isServiceKind(node.kind)),
    affectedApplications: impacted.filter((node) =>
      isApplicationKind(node.kind),
    ),
  };
}

export function propagateImpact(
  originKey: string,
  nodes: BlastRadiusNode[],
  relationshipConfidence: number,
): ImpactPropagation {
  const confidence = Math.min(1, Math.max(0, relationshipConfidence));
  const propagated: PropagatedImpactNode[] = nodes.map((node) => ({
    entityKey: node.entityKey,
    kind: node.kind,
    name: node.name,
    distance: node.distance,
    score: roundScore(
      confidence * Math.pow(IMPACT_DECAY, Math.max(0, node.distance - 1)),
    ),
  }));
  return { originKey, nodes: propagated };
}

export function shouldSuppressIndependentIncidents(input: {
  config: RootCauseSuppressionConfig;
  nodeKeys: string[];
  ancestorKey: string | null;
  relationshipConfidence: number;
  maxDistance: number | null;
}): boolean {
  if (!input.config.enabled) return false;
  if (!input.ancestorKey) return false;
  if (input.nodeKeys.length < 2) return false;
  if (input.relationshipConfidence < input.config.minConfidence) return false;
  if (input.maxDistance == null) return false;
  return input.maxDistance <= input.config.maxHops;
}

export function applyTopologyComponent(
  correlation: ClusterCorrelation,
  topologyScore: number,
  extraEvidence: CorrelationEvidence[],
): ClusterCorrelation {
  const components = {
    ...correlation.components,
    topologyScore: roundScore(topologyScore),
  };
  const total = roundScore(
    correlation.weights.temporal * components.temporalScore +
      correlation.weights.entity * components.entityScore +
      correlation.weights.topology * components.topologyScore +
      correlation.weights.label * components.labelScore +
      correlation.weights.historical * components.historicalScore,
  );
  const details = [...correlation.details, ...extraEvidence];
  return {
    score: total,
    components,
    weights: correlation.weights,
    evidence: details.map((item) => item.statement),
    details,
  };
}

export function topologyEvidenceStatements(input: {
  ancestorKey: string | null;
  ancestorName: string | null;
  topologyScore: number;
  causalScore: number;
  relationshipConfidence: number;
  suppressed: number;
}): CorrelationEvidence[] {
  const items: CorrelationEvidence[] = [];
  if (input.ancestorKey) {
    items.push({
      kind: 'ancestor',
      statement: `Ancestro común topológico: ${input.ancestorName ?? input.ancestorKey}`,
      score: roundScore(input.relationshipConfidence),
      details: { ancestorKey: input.ancestorKey },
    });
  }
  items.push({
    kind: 'topology_path',
    statement: `Score topológico dirigido ${input.topologyScore} (causal ${input.causalScore}); confianza de relación ${input.relationshipConfidence}`,
    score: input.topologyScore,
    details: {
      topologyScore: input.topologyScore,
      causalScore: input.causalScore,
      relationshipConfidence: input.relationshipConfidence,
    },
  });
  if (input.suppressed > 0) {
    items.push({
      kind: 'suppression',
      statement: `Supresión de causa raíz: ${input.suppressed} incidente(s) independientes de alta prioridad no creados; la evidencia de síntomas se conserva`,
      score: 1,
      details: { independentIncidentsSuppressed: input.suppressed },
    });
  }
  return items;
}
