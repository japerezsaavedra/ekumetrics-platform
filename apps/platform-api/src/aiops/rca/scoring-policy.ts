import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  readNonNegativeNumber,
  readPositiveInt,
  type EnvReader,
} from '../correlation-weights';
import type { RcaScoreWeights } from '../types/root-cause-candidate';
import { PrismaService } from '../../prisma/prisma.service';
import { RCA_POLICY_KIND, RCA_POLICY_NAME } from './constants';

export const RCA_SCORING_POLICY = 'RcaScoringPolicy';

export const DEFAULT_RCA_WEIGHTS: RcaScoreWeights = {
  temporal: 0.2,
  topology: 0.25,
  anomaly: 0.2,
  dependency: 0.25,
  historical: 0.1,
};

export const DEFAULT_RCA_HOPS = 8;

const WEIGHT_ENV: Record<keyof RcaScoreWeights, string> = {
  temporal: 'AIOPS_RCA_WEIGHT_TEMPORAL',
  topology: 'AIOPS_RCA_WEIGHT_TOPOLOGY',
  anomaly: 'AIOPS_RCA_WEIGHT_ANOMALY',
  dependency: 'AIOPS_RCA_WEIGHT_DEPENDENCY',
  historical: 'AIOPS_RCA_WEIGHT_HISTORICAL',
};

export function normalizeRcaWeights(weights: RcaScoreWeights): RcaScoreWeights {
  const total =
    weights.temporal +
    weights.topology +
    weights.anomaly +
    weights.dependency +
    weights.historical;
  if (total <= 0) return { ...DEFAULT_RCA_WEIGHTS };
  return {
    temporal: weights.temporal / total,
    topology: weights.topology / total,
    anomaly: weights.anomaly / total,
    dependency: weights.dependency / total,
    historical: weights.historical / total,
  };
}

export function loadRcaWeights(
  getEnv: EnvReader = (key) => process.env[key],
): RcaScoreWeights {
  return normalizeRcaWeights({
    temporal: readNonNegativeNumber(
      getEnv,
      WEIGHT_ENV.temporal,
      DEFAULT_RCA_WEIGHTS.temporal,
    ),
    topology: readNonNegativeNumber(
      getEnv,
      WEIGHT_ENV.topology,
      DEFAULT_RCA_WEIGHTS.topology,
    ),
    anomaly: readNonNegativeNumber(
      getEnv,
      WEIGHT_ENV.anomaly,
      DEFAULT_RCA_WEIGHTS.anomaly,
    ),
    dependency: readNonNegativeNumber(
      getEnv,
      WEIGHT_ENV.dependency,
      DEFAULT_RCA_WEIGHTS.dependency,
    ),
    historical: readNonNegativeNumber(
      getEnv,
      WEIGHT_ENV.historical,
      DEFAULT_RCA_WEIGHTS.historical,
    ),
  });
}

export function loadRcaHops(
  getEnv: EnvReader = (key) => process.env[key],
): number {
  return readPositiveInt(getEnv, 'AIOPS_RCA_HOPS', DEFAULT_RCA_HOPS);
}

export function parseRcaWeightsPayload(
  payload: unknown,
): RcaScoreWeights | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  const source =
    raw.weights && typeof raw.weights === 'object'
      ? (raw.weights as Record<string, unknown>)
      : raw;
  const temporal = asNonNegative(source.temporal);
  const topology = asNonNegative(source.topology);
  const anomaly = asNonNegative(source.anomaly);
  const dependency = asNonNegative(source.dependency);
  const historical = asNonNegative(source.historical);
  if (
    temporal == null &&
    topology == null &&
    anomaly == null &&
    dependency == null &&
    historical == null
  ) {
    return null;
  }
  return normalizeRcaWeights({
    temporal: temporal ?? DEFAULT_RCA_WEIGHTS.temporal,
    topology: topology ?? DEFAULT_RCA_WEIGHTS.topology,
    anomaly: anomaly ?? DEFAULT_RCA_WEIGHTS.anomaly,
    dependency: dependency ?? DEFAULT_RCA_WEIGHTS.dependency,
    historical: historical ?? DEFAULT_RCA_WEIGHTS.historical,
  });
}

export function parseRcaHopsPayload(payload: unknown, fallback: number): number {
  if (!payload || typeof payload !== 'object') return fallback;
  const hops = asNonNegative((payload as Record<string, unknown>).hops);
  if (hops == null || hops < 1) return fallback;
  return Math.trunc(hops);
}

function asNonNegative(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

/**
 * RcaScoringPolicy canónica: tenant+environment → tenant default → Policy
 * genérica (kind/name = rca_scoring, fallback Wave 2) → env → defaults.
 */
@Injectable()
export class RcaScoringPolicyLoader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getWeights(
    tenantId: string,
    environment?: string,
  ): Promise<RcaScoreWeights> {
    const structured = await this.readStructured(tenantId, environment);
    if (structured?.weights) return structured.weights;
    const legacy = await this.readLegacyPolicy(tenantId);
    if (legacy?.weights) return legacy.weights;
    return loadRcaWeights((key) => this.config.get<string>(key));
  }

  async getHops(tenantId: string, environment?: string): Promise<number> {
    const structured = await this.readStructured(tenantId, environment);
    if (structured?.hops) return structured.hops;
    const legacy = await this.readLegacyPolicy(tenantId);
    const envHops = loadRcaHops((key) => this.config.get<string>(key));
    return legacy?.hops ?? envHops;
  }

  private async readStructured(
    tenantId: string,
    environment?: string,
  ): Promise<{ weights: RcaScoreWeights | null; hops?: number } | null> {
    if (!tenantId) return null;
    const env = environment?.trim() ?? '';
    if (env) {
      const exact = await this.prisma.rcaScoringPolicy.findUnique({
        where: { tenantId_environment: { tenantId, environment: env } },
      });
      if (exact && exact.tenantId === tenantId) {
        return fromStructured(exact);
      }
    }
    const tenantDefault = await this.prisma.rcaScoringPolicy.findUnique({
      where: { tenantId_environment: { tenantId, environment: '' } },
    });
    if (tenantDefault && tenantDefault.tenantId === tenantId) {
      return fromStructured(tenantDefault);
    }
    return null;
  }

  private async readLegacyPolicy(tenantId: string): Promise<{
    weights: RcaScoreWeights | null;
    hops?: number;
  } | null> {
    if (!tenantId) return null;
    const row = await this.prisma.policy.findFirst({
      where: {
        tenantId,
        OR: [{ name: RCA_POLICY_NAME }, { kind: RCA_POLICY_KIND }],
      },
      select: { payload: true },
    });
    if (!row) return null;
    const weights = parseRcaWeightsPayload(row.payload);
    const hops = parseRcaHopsPayload(row.payload, 0);
    return {
      weights,
      hops: hops > 0 ? hops : undefined,
    };
  }
}

function fromStructured(row: {
  temporalWeight: number;
  topologyWeight: number;
  anomalyWeight: number;
  dependencyWeight: number;
  historicalWeight: number;
  hops: number;
}): { weights: RcaScoreWeights; hops: number } {
  return {
    weights: normalizeRcaWeights({
      temporal: row.temporalWeight,
      topology: row.topologyWeight,
      anomaly: row.anomalyWeight,
      dependency: row.dependencyWeight,
      historical: row.historicalWeight,
    }),
    hops: row.hops > 0 ? row.hops : DEFAULT_RCA_HOPS,
  };
}
