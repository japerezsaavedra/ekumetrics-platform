import type {
  BlastRadius,
  RootCauseSuppression,
  TopologyEvidenceSummary,
} from './topology-correlation/topology-correlation.types';

export type CorrelateAlert = {
  fingerprint: string;
  name: string;
  severity: string;
  siteId?: string;
  nodeHint?: string;
  startsAt?: string | null;
  labels?: Record<string, string>;
};

export type CorrelationEvidenceKind =
  | 'temporal'
  | 'entity'
  | 'topology'
  | 'label'
  | 'historical'
  | 'dedup'
  | 'causality'
  | 'ancestor'
  | 'topology_path'
  | 'suppression';

/** Evidencia estructurada de por qué se correlacionó un cluster. */
export type CorrelationEvidence = {
  kind: CorrelationEvidenceKind;
  statement: string;
  score: number;
  details?: Record<string, string | number | boolean | null>;
};

export type CorrelationScoreComponents = {
  temporalScore: number;
  entityScore: number;
  topologyScore: number;
  labelScore: number;
  historicalScore: number;
};

export type CorrelationScore = CorrelationScoreComponents & {
  total: number;
  weights: {
    temporal: number;
    entity: number;
    topology: number;
    label: number;
    historical: number;
  };
};

export type ClusterCorrelation = {
  score: number;
  components: CorrelationScoreComponents;
  weights: CorrelationScore['weights'];
  evidence: string[];
  details: CorrelationEvidence[];
};

export type IncidentCorrelationMembers = {
  alerts: Array<{
    fingerprint: string;
    name: string;
    severity: string;
    nodeHint: string | null;
  }>;
  impact: string[];
  correlation: ClusterCorrelation;
  collectorEvents: Array<{
    fingerprint: string;
    signal: string;
    assetKey: string | null;
  }>;
  blastRadius?: BlastRadius | null;
  suppression?: RootCauseSuppression;
  topologyEvidence?: TopologyEvidenceSummary;
};
