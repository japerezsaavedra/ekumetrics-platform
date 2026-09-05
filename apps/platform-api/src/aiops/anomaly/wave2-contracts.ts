/** Reexporta contratos Wave 2. El motor de anomalías vive en este directorio. */
export {
  ANOMALY_ALGORITHMS,
  ANOMALY_DETECTOR_TYPES,
  DETECTOR_TYPE_TO_ALGORITHM,
  EventSubjects,
  AiopsMetricNames,
  Wave2EventSubjects,
  assertAiopsBusPayload,
  isAnomalyAlgorithm,
  isAnomalyDetectorType,
  type AnomalyAlgorithm,
  type AnomalyDetectInput,
  type AnomalyDetector,
  type AnomalyResult,
  type AnomaliesDetectedPayload,
  type AiopsAnomalyPolicyRecord,
  type StaticThresholdConfig,
} from '../contracts';
