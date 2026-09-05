/**
 * Nombres de series OpenTelemetry / Prometheus para AIOps Wave 2.
 * Los workstreams registran instrumentos con estas constantes; no hardcodear strings.
 * Wave 1 ya emite aiops_correlation_* desde CorrelationMetrics (no se duplica aquí la implementación).
 */
export const AiopsMetricNames = {
  ANOMALIES_DETECTED_TOTAL: 'aiops_anomalies_detected_total',
  ANOMALY_DETECTION_DURATION_SECONDS: 'aiops_anomaly_detection_duration_seconds',
  ANOMALY_PERSISTENCE_TOTAL: 'aiops_anomaly_persistence_total',
  EVENTS_INGESTED_PUBLISHED_TOTAL: 'aiops_events_ingested_published_total',
  EVENTS_INGESTED_PUBLISH_FAILURES_TOTAL:
    'aiops_events_ingested_publish_failures_total',
  RCA_REQUESTS_TOTAL: 'aiops_rca_requests_total',
  RCA_COMPLETED_TOTAL: 'aiops_rca_completed_total',
  RCA_DURATION_SECONDS: 'aiops_rca_duration_seconds',
  RCA_CONFIDENCE: 'aiops_rca_confidence',
  RCA_REQUESTED_PUBLISHED_TOTAL: 'aiops_rca_requested_published_total',
  RCA_REQUESTED_PUBLISH_FAILURES_TOTAL:
    'aiops_rca_requested_publish_failures_total',
  RCA_RESULTS_PERSISTED_TOTAL: 'aiops_rca_results_persisted_total',
  TOPOLOGY_CORRELATIONS_TOTAL: 'aiops_topology_correlations_total',
  ROOT_CAUSE_SUPPRESSIONS_TOTAL: 'aiops_root_cause_suppressions_total',
  INCIDENT_ENRICHMENT_DURATION_SECONDS:
    'aiops_incident_enrichment_duration_seconds',
  ENRICHMENT_UPDATES_TOTAL: 'aiops_enrichment_updates_total',
  FEEDBACK_TOTAL: 'aiops_feedback_total',
  INVESTIGATIONS_TOTAL: 'aiops_investigations_total',
  INVESTIGATION_DURATION_SECONDS: 'aiops_investigation_duration_seconds',
  INVESTIGATION_FAILURES_TOTAL: 'aiops_investigation_failures_total',
  AIOPS_AGENT_EXECUTIONS_TOTAL: 'aiops_agent_executions_total',
  AIOPS_AGENT_DURATION_SECONDS: 'aiops_agent_duration_seconds',
  AIOPS_AGENT_FAILURES_TOTAL: 'aiops_agent_failures_total',
  AIOPS_AGENT_TIMEOUTS_TOTAL: 'aiops_agent_timeouts_total',
  TOOL_CALLS_TOTAL: 'aiops_tool_calls_total',
  TOOL_CALL_DURATION_SECONDS: 'aiops_tool_call_duration_seconds',
  LLM_CALLS_TOTAL: 'aiops_llm_calls_total',
  LLM_DURATION_SECONDS: 'aiops_llm_duration_seconds',
  LLM_FAILURES_TOTAL: 'aiops_llm_failures_total',
  INVESTIGATION_BUDGET_EXHAUSTED_TOTAL:
    'aiops_investigation_budget_exhausted_total',
} as const;

export type AiopsMetricName =
  (typeof AiopsMetricNames)[keyof typeof AiopsMetricNames];

export const AIOPS_METRIC_NAME_VALUES: readonly AiopsMetricName[] =
  Object.values(AiopsMetricNames);
