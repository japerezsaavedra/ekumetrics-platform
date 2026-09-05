export type PathDirection = 'upstream' | 'downstream' | 'undirected' | 'none';

export type TopologyAlertItem = {
  alert: {
    fingerprint: string;
    name: string;
    severity: string;
    siteId?: string;
    nodeHint?: string;
    startsAt?: string | null;
    labels?: Record<string, string>;
  };
  nodeKey: string | null;
};

export type BlastRadiusNode = {
  entityKey: string;
  kind: string;
  name: string;
  distance: number;
};

/** Impacto estructurado desde un origen topológico (causa o nodo alerta). */
export type BlastRadius = {
  originKey: string;
  hops: number;
  directDependents: BlastRadiusNode[];
  indirectDependents: BlastRadiusNode[];
  affectedServices: BlastRadiusNode[];
  affectedApplications: BlastRadiusNode[];
};

export type PropagatedImpactNode = {
  entityKey: string;
  kind: string;
  name: string;
  distance: number;
  score: number;
};

export type ImpactPropagation = {
  originKey: string;
  nodes: PropagatedImpactNode[];
};

export type DependencyPathScore = {
  fromKey: string;
  toKey: string;
  distance: number | null;
  direction: PathDirection;
  relationshipConfidence: number;
  topologyScore: number;
  causalScore: number;
};

export type RootCauseSuppression = {
  applied: boolean;
  enabled: boolean;
  reason: string;
  rootCauseKey: string | null;
  rootCauseName: string | null;
  suppressedEntityKeys: string[];
  /** Los síntomas aguas abajo siguen en members.alerts / evidence. */
  evidenceRetained: boolean;
  independentIncidentsSuppressed: number;
};

export type TopologyEvidenceSummary = {
  tenantId: string;
  commonAncestorKey: string | null;
  commonAncestorName: string | null;
  topologyScore: number;
  causalScore: number;
  relationshipConfidence: number;
  pathScores: DependencyPathScore[];
  impactPropagation: ImpactPropagation | null;
  statements: string[];
};

export type TopologyClusterEnrichment = {
  tenantId: string;
  blastRadius: BlastRadius | null;
  suppression: RootCauseSuppression;
  topologyEvidence: TopologyEvidenceSummary;
};

export type TopologyCorrelationApplyInput = {
  tenantId: string;
  tenantSlug: string;
  clusters: TopologyAlertItem[][];
  hops: number;
  windowMs: number;
};

export type TopologyCorrelationApplyResult = {
  clusters: TopologyAlertItem[][];
  enrichments: TopologyClusterEnrichment[];
  suppressions: number;
};

export type TopologyCorrelationEventPayload = {
  tenantId: string;
  tenantSlug: string;
  clusterKey?: string;
  incidentId?: string;
  siteId?: string | null;
  blastRadius?: BlastRadius | null;
  suppression?: RootCauseSuppression;
  topologyEvidence?: TopologyEvidenceSummary;
};

export type RelationshipFact = {
  fromKey: string;
  toKey: string;
  relation: string;
  source: string;
  confidence: number | null;
};

export type RelationshipSourceGroup = 'collector' | 'otel' | 'cmdb' | 'inferred';
