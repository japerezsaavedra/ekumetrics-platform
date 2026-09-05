export {
  HISTORICAL_ALGORITHM,
  HISTORICAL_DIMENSIONS,
  HISTORICAL_SOURCE,
  NEUTRAL_HISTORICAL_SCORE,
  RCA_FEEDBACK_ACTIONS,
  SIGNATURE_VERSION,
  isRcaFeedbackAction,
  type DimensionScore,
  type HistoricalContribution,
  type HistoricalDimension,
  type HistoricalMatch,
  type HistoricalMatchEvidence,
  type IncidentSignature,
  type IncidentSignatureInput,
  type RcaFeedback,
  type RcaFeedbackAction,
  type ResolutionRecord,
  type StableSignatureCharacteristics,
} from './types';
export {
  HISTORICAL_EVIDENCE,
  NeutralHistoricalEvidence,
  neutralHistoricalContribution,
  type HistoricalEvidencePort,
} from './historical-evidence.port';
export {
  HISTORICAL_REPOSITORY,
  type CreateFeedbackInput,
  type HistoricalRepository,
  type UpsertResolutionInput,
  type UpsertSignatureInput,
} from './historical.repository';
export { HistoricalService, type RecordFeedbackInput } from './historical.service';
export { HistoricalModule } from './historical.module';
export {
  buildStableCharacteristics,
  canonicalizeTopology,
  hashIncidentSignature,
} from './signature';
export {
  DISAGREEMENT_CAP,
  ROOT_CAUSE_BONUS,
  SIMILARITY_WEIGHTS,
  jaccard,
  scoreSignatureSimilarity,
} from './similarity';
