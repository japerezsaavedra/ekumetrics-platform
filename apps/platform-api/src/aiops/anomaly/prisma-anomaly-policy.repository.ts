import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assertTenantScope, TenantScopeError } from '../persistence/tenant-scope.error';
import type { AnomalyAlgorithm, AnomalyPolicy } from './anomaly-policy';
import { resolveAnomalyPolicy, type PolicyMatchInput, type ResolvedAnomalyPolicy } from './anomaly-policy';
import type { AnomalyPolicyRepository } from './anomaly-policy.repository';

@Injectable()
export class PrismaAnomalyPolicyRepository implements AnomalyPolicyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listByTenant(tenantId: string): Promise<AnomalyPolicy[]> {
    assertTenantScope(tenantId);
    const rows = await this.prisma.aiopsAnomalyPolicy.findMany({
      where: { tenantId, enabled: true },
    });
    return rows
      .filter((row) => row.tenantId === tenantId)
      .map(fromRow);
  }

  async upsert(policy: AnomalyPolicy): Promise<AnomalyPolicy> {
    assertTenantScope(policy.tenantId);
    const existing = await this.prisma.aiopsAnomalyPolicy.findUnique({
      where: { id: policy.id },
    });
    if (existing && existing.tenantId !== policy.tenantId) {
      throw new TenantScopeError();
    }
    const data = toRow(policy);
    await this.prisma.aiopsAnomalyPolicy.upsert({
      where: { id: policy.id },
      create: data,
      update: {
        siteId: data.siteId,
        entityType: data.entityType,
        entityId: data.entityId,
        metric: data.metric,
        environment: data.environment,
        detectorType: data.detectorType,
        config: data.config,
        enabled: data.enabled,
      },
    });
    return policy;
  }

  async resolve(
    tenantId: string,
    input: Omit<PolicyMatchInput, 'tenantId'>,
  ): Promise<ResolvedAnomalyPolicy> {
    const scoped = await this.listByTenant(tenantId);
    return resolveAnomalyPolicy(tenantId, scoped, input);
  }
}

function toRow(policy: AnomalyPolicy) {
  return {
    id: policy.id,
    tenantId: policy.tenantId,
    siteId: policy.siteId,
    entityType: policy.entityType,
    entityId: policy.entityId,
    metric: policy.metricName,
    environment: policy.environment,
    detectorType: policy.enabledDetectors?.[0] ?? 'static_threshold',
    config: {
      enabledDetectors: policy.enabledDetectors,
      minScore: policy.minScore,
      minSamples: policy.minSamples,
      ewmaAlpha: policy.ewmaAlpha,
      ewmaLambda: policy.ewmaLambda,
      robustZThreshold: policy.robustZThreshold,
      rollingIqrK: policy.rollingIqrK,
      staleMs: policy.staleMs,
      warn: policy.warn,
      crit: policy.crit,
      direction: policy.direction,
    } as Prisma.InputJsonValue,
    enabled: true,
  };
}

function fromRow(row: {
  id: string;
  tenantId: string;
  siteId: string | null;
  entityType: string | null;
  entityId: string | null;
  metric: string | null;
  environment: string | null;
  detectorType: string;
  config: unknown;
}): AnomalyPolicy {
  const config =
    row.config && typeof row.config === 'object' && !Array.isArray(row.config)
      ? (row.config as Record<string, unknown>)
      : {};
  const enabled = Array.isArray(config.enabledDetectors)
    ? (config.enabledDetectors as AnomalyAlgorithm[])
    : row.detectorType
      ? [row.detectorType as AnomalyAlgorithm]
      : undefined;
  return {
    id: row.id,
    tenantId: row.tenantId,
    siteId: row.siteId ?? undefined,
    entityType: row.entityType ?? undefined,
    entityId: row.entityId ?? undefined,
    metricName: row.metric ?? undefined,
    environment: row.environment ?? undefined,
    enabledDetectors: enabled,
    minScore: asNumber(config.minScore),
    minSamples: asNumber(config.minSamples),
    ewmaAlpha: asNumber(config.ewmaAlpha),
    ewmaLambda: asNumber(config.ewmaLambda),
    robustZThreshold: asNumber(config.robustZThreshold),
    rollingIqrK: asNumber(config.rollingIqrK),
    staleMs: asNumber(config.staleMs),
    warn: asNumber(config.warn),
    crit: asNumber(config.crit),
    direction: config.direction === 'below' ? 'below' : 'above',
  };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
