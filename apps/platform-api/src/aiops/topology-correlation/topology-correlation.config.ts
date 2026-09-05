import {
  DEFAULT_CORRELATION_HOPS,
  readNonNegativeNumber,
  readPositiveInt,
  type EnvReader,
} from '../correlation-weights';
import { TOPOLOGY_DEFAULT_HOPS } from '../topology.relations';

export type RootCauseSuppressionConfig = {
  enabled: boolean;
  minConfidence: number;
  maxHops: number;
};

export type TopologyCorrelationConfig = {
  suppression: RootCauseSuppressionConfig;
  blastHops: number;
};

export const DEFAULT_ROOT_CAUSE_SUPPRESSION: RootCauseSuppressionConfig = {
  enabled: true,
  minConfidence: 0.55,
  maxHops: DEFAULT_CORRELATION_HOPS,
};

export function readBooleanEnv(
  getEnv: EnvReader,
  key: string,
  fallback: boolean,
): boolean {
  const raw = getEnv(key)?.trim().toLowerCase();
  if (raw == null || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

export function loadRootCauseSuppressionConfig(
  getEnv: EnvReader = (key) => process.env[key],
): RootCauseSuppressionConfig {
  const maxHops = readPositiveInt(
    getEnv,
    'AIOPS_ROOT_CAUSE_SUPPRESSION_MAX_HOPS',
    DEFAULT_ROOT_CAUSE_SUPPRESSION.maxHops,
  );
  const minConfidence = Math.min(
    1,
    readNonNegativeNumber(
      getEnv,
      'AIOPS_ROOT_CAUSE_SUPPRESSION_MIN_CONFIDENCE',
      DEFAULT_ROOT_CAUSE_SUPPRESSION.minConfidence,
    ),
  );
  return {
    enabled: readBooleanEnv(
      getEnv,
      'AIOPS_ROOT_CAUSE_SUPPRESSION_ENABLED',
      DEFAULT_ROOT_CAUSE_SUPPRESSION.enabled,
    ),
    minConfidence,
    maxHops,
  };
}

export function loadTopologyCorrelationConfig(
  getEnv: EnvReader = (key) => process.env[key],
): TopologyCorrelationConfig {
  return {
    suppression: loadRootCauseSuppressionConfig(getEnv),
    blastHops: readPositiveInt(
      getEnv,
      'AIOPS_TOPOLOGY_CORRELATION_HOPS',
      TOPOLOGY_DEFAULT_HOPS,
    ),
  };
}
