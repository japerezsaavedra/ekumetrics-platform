import { Injectable } from '@nestjs/common';
import {
  clampUnit,
  type ComputedPriority,
  type EnrichmentEvidence,
  type IncidentPriorityLevel,
  type PriorityFactorBreakdown,
  type PriorityFactorId,
} from './incident-enrichment.types';

export type PriorityInput = {
  severity: string;
  environment?: string | null;
  blastRadiusEntityCount: number;
  affectedEntityCount: number;
  serviceKinds: readonly string[];
  tenantPolicy?: TenantPriorityPolicy | null;
};

export type TenantPriorityPolicy = {
  boost?: number;
  minLevel?: IncidentPriorityLevel;
  criticalityByKind?: Record<string, number>;
  environmentBoost?: Record<string, number>;
  weightOverrides?: Partial<Record<PriorityFactorId, number>>;
};

export type PriorityWeights = Record<PriorityFactorId, number>;

export const DEFAULT_PRIORITY_WEIGHTS: PriorityWeights = {
  severity: 0.25,
  serviceCriticality: 0.2,
  blastRadius: 0.2,
  environment: 0.15,
  affectedEntityCount: 0.1,
  tenantPolicy: 0.1,
};

/** Solo severidad cruda de alerta. No usar como algoritmo de producto. */
export const SEVERITY_ONLY_WEIGHTS: PriorityWeights = {
  severity: 1,
  serviceCriticality: 0,
  blastRadius: 0,
  environment: 0,
  affectedEntityCount: 0,
  tenantPolicy: 0,
};

export type PriorityContributor = {
  id: PriorityFactorId;
  algorithm: string;
  source: string;
  score(input: PriorityInput): { score: number; evidence: string };
};

const DEFAULT_KIND_CRITICALITY: Record<string, number> = {
  database: 0.95,
  db: 0.95,
  service: 0.88,
  deployment: 0.88,
  statefulset: 0.88,
  pod: 0.72,
  container: 0.7,
  host: 0.5,
  node: 0.5,
  switch: 0.42,
  device: 0.4,
};

const ENV_SCORE: Record<string, number> = {
  prod: 1,
  production: 1,
  staging: 0.45,
  pre: 0.45,
  preprod: 0.45,
  dev: 0.15,
  development: 0.15,
  test: 0.12,
  qa: 0.2,
};

const PRIORITY_ALGORITHM = 'weighted_priority_v1';
const PRIORITY_SOURCE = 'IncidentPriorityCalculator';

export function severityRankScore(severity: string): number {
  switch (severity.trim().toLowerCase()) {
    case 'critical':
      return 1;
    case 'error':
    case 'fatal':
      return 0.8;
    case 'warning':
      return 0.45;
    case 'info':
      return 0.15;
    default:
      return 0.3;
  }
}

export function environmentScore(
  environment: string | null | undefined,
  policy?: TenantPriorityPolicy | null,
): number {
  const key = (environment ?? '').trim().toLowerCase();
  if (!key) return 0.5;
  const fromPolicy = policy?.environmentBoost?.[key];
  if (typeof fromPolicy === 'number') return clampUnit(fromPolicy);
  return ENV_SCORE[key] ?? 0.5;
}

export function serviceCriticalityScore(
  kinds: readonly string[],
  policy?: TenantPriorityPolicy | null,
): number {
  if (kinds.length === 0) return 0.35;
  let max = 0;
  for (const kind of kinds) {
    const key = kind.trim().toLowerCase();
    const override = policy?.criticalityByKind?.[key];
    const score =
      typeof override === 'number'
        ? clampUnit(override)
        : (DEFAULT_KIND_CRITICALITY[key] ?? 0.35);
    if (score > max) max = score;
  }
  return max;
}

export function blastRadiusScore(entityCount: number): number {
  return clampUnit(entityCount / 10);
}

export function affectedEntityScore(entityCount: number): number {
  return clampUnit(entityCount / 8);
}

export function tenantPolicyScore(policy?: TenantPriorityPolicy | null): number {
  if (!policy) return 0;
  if (typeof policy.boost === 'number') return clampUnit(policy.boost);
  return 0.2;
}

export function normalizeWeights(weights: PriorityWeights): PriorityWeights {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return { ...DEFAULT_PRIORITY_WEIGHTS };
  const next = { ...weights };
  (Object.keys(next) as PriorityFactorId[]).forEach((key) => {
    next[key] = next[key] / total;
  });
  return next;
}

export function priorityLevelFromScore(score: number): IncidentPriorityLevel {
  if (score >= 0.75) return 'P1';
  if (score >= 0.55) return 'P2';
  if (score >= 0.35) return 'P3';
  return 'P4';
}

const LEVEL_RANK: Record<IncidentPriorityLevel, number> = {
  P1: 4,
  P2: 3,
  P3: 2,
  P4: 1,
};

function raiseToMin(
  level: IncidentPriorityLevel,
  min?: IncidentPriorityLevel,
): IncidentPriorityLevel {
  if (!min) return level;
  return LEVEL_RANK[level] >= LEVEL_RANK[min] ? level : min;
}

export function defaultPriorityContributors(): PriorityContributor[] {
  return [
    {
      id: 'severity',
      algorithm: 'severity_rank',
      source: 'incident.severity',
      score: (input) => ({
        score: severityRankScore(input.severity),
        evidence: `severidad=${input.severity || 'unknown'}`,
      }),
    },
    {
      id: 'serviceCriticality',
      algorithm: 'service_criticality_by_kind',
      source: 'topology.kind',
      score: (input) => ({
        score: serviceCriticalityScore(input.serviceKinds, input.tenantPolicy),
        evidence:
          input.serviceKinds.length > 0
            ? `kinds=${[...new Set(input.serviceKinds)].join(',')}`
            : 'sin servicios afectados tipados',
      }),
    },
    {
      id: 'blastRadius',
      algorithm: 'blast_radius_entity_count',
      source: 'graph.impact',
      score: (input) => ({
        score: blastRadiusScore(input.blastRadiusEntityCount),
        evidence: `entidades_en_radio=${input.blastRadiusEntityCount}`,
      }),
    },
    {
      id: 'environment',
      algorithm: 'environment_tier',
      source: 'agent_event.environment',
      score: (input) => ({
        score: environmentScore(input.environment, input.tenantPolicy),
        evidence: `environment=${input.environment || 'unknown'}`,
      }),
    },
    {
      id: 'affectedEntityCount',
      algorithm: 'affected_entity_count',
      source: 'incident.members',
      score: (input) => ({
        score: affectedEntityScore(input.affectedEntityCount),
        evidence: `entidades_afectadas=${input.affectedEntityCount}`,
      }),
    },
    {
      id: 'tenantPolicy',
      algorithm: 'tenant_priority_policy',
      source: 'policy.aiops.priority',
      score: (input) => ({
        score: tenantPolicyScore(input.tenantPolicy),
        evidence: input.tenantPolicy
          ? 'politica de tenant aplicada'
          : 'sin politica de tenant',
      }),
    },
  ];
}

/**
 * Calculadora extensible. La prioridad de producto no se deriva solo
 * de la severidad cruda de la alerta.
 */
@Injectable()
export class IncidentPriorityCalculator {
  private readonly contributors: PriorityContributor[];
  private readonly baseWeights: PriorityWeights;

  constructor(opts?: {
    weights?: PriorityWeights;
    contributors?: PriorityContributor[];
  }) {
    this.contributors = opts?.contributors ?? defaultPriorityContributors();
    this.baseWeights = opts?.weights ?? DEFAULT_PRIORITY_WEIGHTS;
  }

  /** Extiende el set de factores sin reemplazar el núcleo. */
  withContributor(contributor: PriorityContributor): IncidentPriorityCalculator {
    return new IncidentPriorityCalculator({
      weights: this.baseWeights,
      contributors: [
        ...this.contributors.filter((item) => item.id !== contributor.id),
        contributor,
      ],
    });
  }

  calculate(input: PriorityInput): ComputedPriority {
    const weights = normalizeWeights({
      ...this.baseWeights,
      ...(input.tenantPolicy?.weightOverrides ?? {}),
    });
    const factors: PriorityFactorBreakdown[] = [];
    let total = 0;
    let confidenceAcc = 0;
    let weightAcc = 0;
    for (const contributor of this.contributors) {
      const weight = weights[contributor.id] ?? 0;
      const result = contributor.score(input);
      const score = clampUnit(result.score);
      const weighted = score * weight;
      total += weighted;
      confidenceAcc += weight > 0 ? 0.8 * weight : 0;
      weightAcc += weight;
      factors.push({
        id: contributor.id,
        score,
        weight,
        weighted,
        evidence: result.evidence,
        algorithm: contributor.algorithm,
        source: contributor.source,
        confidence: 0.8,
      });
    }
    const score = clampUnit(total);
    const level = raiseToMin(
      priorityLevelFromScore(score),
      input.tenantPolicy?.minLevel,
    );
    const evidence: EnrichmentEvidence[] = factors.map((factor) => ({
      kind: 'priority',
      statement: `${factor.id}: ${factor.evidence}`,
      score: factor.score,
      confidence: factor.confidence,
      algorithm: factor.algorithm,
      source: factor.source,
      details: {
        weight: Number(factor.weight.toFixed(4)),
        weighted: Number(factor.weighted.toFixed(4)),
      },
    }));
    return {
      level,
      score,
      confidence: clampUnit(weightAcc > 0 ? confidenceAcc / weightAcc : 0.5),
      algorithm: PRIORITY_ALGORITHM,
      source: PRIORITY_SOURCE,
      evidence,
      factors,
    };
  }
}
