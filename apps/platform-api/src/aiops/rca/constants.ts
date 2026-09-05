export const RCA_ALGORITHM = 'weighted_subscores_v1';
export const RCA_SOURCE = 'deterministic_rca' as const;

/** Sin historial: no se inventa recurrencia. 0.5 = desconocido / no informativo. */
export const NEUTRAL_HISTORICAL_SCORE = 0.5;

/** Sin relación dirigida aguas abajo, la precedencia temporal no es señal causal. */
export const NEUTRAL_TEMPORAL_SCORE = 0.5;

/** Sin dirección de dependencia en el grafo, no se asume quién causa a quién. */
export const NEUTRAL_DEPENDENCY_SCORE = 0.5;

export const RCA_POLICY_KIND = 'rca_scoring';
export const RCA_POLICY_NAME = 'rca_scoring';

export const RCA_CONSUMER_NAME = 'aiops-rca-engine';
export const RCA_PRODUCED_BY = 'platform-api.rca-engine';

export const CAUSALITY_DISCLAIMER =
  'La precedencia temporal es una señal, no una prueba de causalidad.';

export const SERVICE_KINDS = new Set([
  'service',
  'application',
  'api',
  'frontend',
  'backend',
  'workload',
  'app',
]);
