/**
 * Contratos compartidos AIOps Wave 2.
 * Importar desde aquí (workstreams de anomalía, RCA, topología, enrichment, histórico).
 * No implementar motores en este módulo.
 */
export {
  ANOMALY_ALGORITHMS,
  ANOMALY_DETECTOR_TYPES,
  DETECTOR_TYPE_TO_ALGORITHM,
  isAnomalyAlgorithm,
  isAnomalyDetectorType,
  type AiopsAnomalyPolicyRecord,
  type AiopsAnomalyPolicyTarget,
  type AnomalyAlgorithm,
  type AnomalyDetectInput,
  type AnomalyDetector,
  type AnomalyDetectorConfigMap,
  type AnomalyDetectorType,
  type AnomalyResult,
  type AnomalySeriesPoint,
  type EwmaConfig,
  type RobustZScoreConfig,
  type RollingBaselineConfig,
  type StaticThresholdConfig,
} from './anomaly';
export {
  Wave2EventSubjects,
  assertAiopsBusPayload,
  EventSubjects,
  type AiopsBusPayload,
  type AnomaliesDetectedPayload,
  type EventsIngestedPayload,
  type EventSubject,
  type IncidentEnrichedPayload,
  type IncidentEnrichmentRequestedPayload,
  type InvestigationLifecyclePayload,
  type AiopsAgentLifecyclePayload,
  type RcaCompletedPayload,
  type RcaRequestedPayload,
} from './events';
export {
  createExplainableOutput,
  type ExplainableOutput,
} from './explainable';
export { type IncidentEnrichmentRecord } from './enrichment';
export {
  type HistoricalMatch,
  type IncidentSignatureRecord,
  type ResolutionRecordView,
} from './historical';
export {
  INCIDENT_PRIORITIES,
  INCIDENT_PRIORITY_CALCULATOR,
  type IncidentPriority,
  type IncidentPriorityCalculator,
  type IncidentPriorityInput,
} from './incident-priority';
export {
  AIOPS_METRIC_NAME_VALUES,
  AiopsMetricNames,
  type AiopsMetricName,
} from './metrics';
export {
  RCA_FEEDBACK_ACTIONS,
  isRcaFeedbackAction,
  parseRcaFeedbackAction,
  type RcaFeedbackAction,
  type RcaFeedbackRecord,
} from './rca-feedback';
export {
  DEFAULT_RCA_SCORING_WEIGHTS,
  defaultRcaScoringPolicy,
  fromPrismaRcaWeights,
  normalizeRcaScoringWeights,
  rcaScoringWeightsTotal,
  toPrismaRcaWeights,
  type PrismaRcaWeightColumns,
  type RcaScoringPolicyRecord,
  type RcaScoringWeights,
  type RcaSuppressionConfig,
} from './rca-scoring-policy';
export {
  blastRadiusEntityCount,
  type BlastRadius,
  type BlastRadiusNode,
  type TopologyImpactResult,
} from './topology-impact';

export { RCA_ENGINE, type RcaEngine, type RcaProposeInput } from '../interfaces/rca-engine';
export {
  ROOT_CAUSE_SOURCES,
  ROOT_CAUSE_STATUSES,
  createRootCauseCandidate,
  createScoredRootCauseCandidate,
  type RcaScoreWeights,
  type RcaSubscores,
  type RootCauseCandidate,
  type RootCauseCandidateStatus,
  type RootCauseSource,
  type ScoredRootCauseCandidate,
} from '../types/root-cause-candidate';
