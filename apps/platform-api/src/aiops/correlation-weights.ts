export type CorrelationWeights = {
  temporal: number;
  entity: number;
  topology: number;
  label: number;
  historical: number;
};

/** Valores por defecto. Override por env; no son pesos de negocio fijos. */
export const DEFAULT_CORRELATION_WEIGHTS: CorrelationWeights = {
  temporal: 0.25,
  entity: 0.25,
  topology: 0.25,
  label: 0.15,
  historical: 0.1,
};

export const DEFAULT_CORRELATION_WINDOW_MS = 5 * 60_000;
export const DEFAULT_CORRELATION_HOPS = 4;

const WEIGHT_ENV: Record<keyof CorrelationWeights, string> = {
  temporal: 'AIOPS_CORRELATION_WEIGHT_TEMPORAL',
  entity: 'AIOPS_CORRELATION_WEIGHT_ENTITY',
  topology: 'AIOPS_CORRELATION_WEIGHT_TOPOLOGY',
  label: 'AIOPS_CORRELATION_WEIGHT_LABEL',
  historical: 'AIOPS_CORRELATION_WEIGHT_HISTORICAL',
};

export type EnvReader = (key: string) => string | undefined;

export function readNonNegativeNumber(
  getEnv: EnvReader,
  key: string,
  fallback: number,
): number {
  const raw = getEnv(key);
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

export function readPositiveInt(
  getEnv: EnvReader,
  key: string,
  fallback: number,
): number {
  const value = Math.trunc(readNonNegativeNumber(getEnv, key, fallback));
  return value > 0 ? value : fallback;
}

export function normalizeCorrelationWeights(
  weights: CorrelationWeights,
): CorrelationWeights {
  const total =
    weights.temporal +
    weights.entity +
    weights.topology +
    weights.label +
    weights.historical;
  if (total <= 0) return { ...DEFAULT_CORRELATION_WEIGHTS };
  return {
    temporal: weights.temporal / total,
    entity: weights.entity / total,
    topology: weights.topology / total,
    label: weights.label / total,
    historical: weights.historical / total,
  };
}

export function loadCorrelationWeights(
  getEnv: EnvReader = (key) => process.env[key],
): CorrelationWeights {
  return normalizeCorrelationWeights({
    temporal: readNonNegativeNumber(
      getEnv,
      WEIGHT_ENV.temporal,
      DEFAULT_CORRELATION_WEIGHTS.temporal,
    ),
    entity: readNonNegativeNumber(
      getEnv,
      WEIGHT_ENV.entity,
      DEFAULT_CORRELATION_WEIGHTS.entity,
    ),
    topology: readNonNegativeNumber(
      getEnv,
      WEIGHT_ENV.topology,
      DEFAULT_CORRELATION_WEIGHTS.topology,
    ),
    label: readNonNegativeNumber(
      getEnv,
      WEIGHT_ENV.label,
      DEFAULT_CORRELATION_WEIGHTS.label,
    ),
    historical: readNonNegativeNumber(
      getEnv,
      WEIGHT_ENV.historical,
      DEFAULT_CORRELATION_WEIGHTS.historical,
    ),
  });
}

export function loadCorrelationWindowMs(
  getEnv: EnvReader = (key) => process.env[key],
): number {
  return readPositiveInt(
    getEnv,
    'AIOPS_CORRELATION_WINDOW_MS',
    DEFAULT_CORRELATION_WINDOW_MS,
  );
}

export function loadCorrelationHops(
  getEnv: EnvReader = (key) => process.env[key],
): number {
  return readPositiveInt(
    getEnv,
    'AIOPS_CORRELATION_HOPS',
    DEFAULT_CORRELATION_HOPS,
  );
}
