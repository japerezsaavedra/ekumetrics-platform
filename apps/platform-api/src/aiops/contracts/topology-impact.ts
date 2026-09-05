import type { RcaEvidence } from '../types/rca-evidence';
import type { ExplainableOutput } from './explainable';

export type BlastRadiusNode = {
  entityKey: string;
  kind: string;
  name: string;
  distance: number;
};

/**
 * Impacto topológico persistible (JSON de IncidentEnrichment.blastRadius).
 * Forma canónica alineada con topology-correlation (originKey, hops, dependientes).
 */
export type BlastRadius = {
  originKey: string;
  hops: number;
  directDependents: BlastRadiusNode[];
  indirectDependents: BlastRadiusNode[];
  affectedServices: BlastRadiusNode[];
  affectedApplications: BlastRadiusNode[];
};

export type TopologyImpactResult = {
  tenantId: string;
  originEntityId: string;
  blastRadius: BlastRadius;
  incidentId?: string;
  dependencyPath?: string[];
  entityCount: number;
  serviceCount: number;
  confidence: number;
  evidence: RcaEvidence[];
  algorithm: string;
  explainable?: ExplainableOutput;
};

export function blastRadiusEntityCount(radius: BlastRadius): number {
  const keys = new Set<string>();
  for (const node of [
    ...radius.directDependents,
    ...radius.indirectDependents,
    ...radius.affectedServices,
    ...radius.affectedApplications,
  ]) {
    keys.add(node.entityKey);
  }
  return keys.size;
}
