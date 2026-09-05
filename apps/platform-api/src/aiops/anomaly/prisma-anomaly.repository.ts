import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assertTenantScope, TenantScopeError } from '../persistence/tenant-scope.error';
import type { AnomalyAlgorithm, AnomalyMetadata, AnomalyResult, AnomalyWindow } from './anomaly-result';
import { ANOMALY_WINDOWS } from './anomaly-result';
import type { AnomalyRepository } from './anomaly.repository';

@Injectable()
export class PrismaAnomalyRepository implements AnomalyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(tenantId: string, result: AnomalyResult): Promise<AnomalyResult> {
    assertTenantScope(tenantId, result.tenantId);
    const existing = await this.prisma.aiopsAnomaly.findUnique({
      where: { id: result.id },
    });
    if (existing && existing.tenantId !== tenantId) {
      throw new TenantScopeError();
    }
    const data = toRow(result);
    await this.prisma.aiopsAnomaly.upsert({
      where: { id: result.id },
      create: data,
      update: {
        entityId: data.entityId,
        metricName: data.metricName,
        timestamp: data.timestamp,
        actualValue: data.actualValue,
        expectedValue: data.expectedValue,
        deviation: data.deviation,
        score: data.score,
        confidence: data.confidence,
        algorithm: data.algorithm,
        window: data.window,
        metadata: data.metadata,
      },
    });
    return result;
  }

  async saveMany(
    tenantId: string,
    results: AnomalyResult[],
  ): Promise<AnomalyResult[]> {
    const saved: AnomalyResult[] = [];
    for (const result of results) {
      saved.push(await this.save(tenantId, result));
    }
    return saved;
  }

  async findByTenant(tenantId: string): Promise<AnomalyResult[]> {
    assertTenantScope(tenantId);
    const rows = await this.prisma.aiopsAnomaly.findMany({
      where: { tenantId },
      orderBy: { timestamp: 'desc' },
    });
    return rows.filter((row) => row.tenantId === tenantId).map(fromRow);
  }

  async findForEntities(
    tenantId: string,
    entityIds: string[],
    opts?: { windowStart?: Date | null; windowEnd?: Date | null },
  ): Promise<AnomalyResult[]> {
    assertTenantScope(tenantId);
    if (entityIds.length === 0) return [];
    const timestamp =
      opts?.windowStart || opts?.windowEnd
        ? {
            ...(opts.windowStart ? { gte: opts.windowStart } : {}),
            ...(opts.windowEnd ? { lte: opts.windowEnd } : {}),
          }
        : undefined;
    const rows = await this.prisma.aiopsAnomaly.findMany({
      where: {
        tenantId,
        entityId: { in: entityIds },
        ...(timestamp ? { timestamp } : {}),
      },
      orderBy: { timestamp: 'desc' },
    });
    return rows.filter((row) => row.tenantId === tenantId).map(fromRow);
  }
}

function toRow(result: AnomalyResult) {
  return {
    id: result.id,
    tenantId: result.tenantId,
    entityId: result.entityId,
    metricName: result.metricName,
    timestamp: new Date(result.timestamp),
    actualValue: result.actualValue,
    expectedValue: result.expectedValue,
    deviation: result.deviation,
    score: result.score,
    confidence: result.confidence,
    algorithm: result.algorithm,
    window: result.window,
    metadata: result.metadata as unknown as Prisma.InputJsonValue,
  };
}

function fromRow(row: {
  id: string;
  tenantId: string;
  entityId: string;
  metricName: string;
  timestamp: Date;
  actualValue: number;
  expectedValue: number | null;
  deviation: number | null;
  score: number;
  confidence: number;
  algorithm: string;
  window: string | null;
  metadata: unknown;
}): AnomalyResult {
  return {
    id: row.id,
    tenantId: row.tenantId,
    entityId: row.entityId,
    metricName: row.metricName,
    timestamp: row.timestamp.toISOString(),
    actualValue: row.actualValue,
    expectedValue: row.expectedValue ?? row.actualValue,
    deviation: row.deviation ?? 0,
    score: row.score,
    confidence: row.confidence,
    algorithm: row.algorithm as AnomalyAlgorithm,
    window: asWindow(row.window),
    metadata: (row.metadata ?? {
      evidence: [],
      source: row.algorithm,
      sampleCount: 0,
    }) as AnomalyMetadata,
  };
}

function asWindow(value: string | null): AnomalyWindow {
  if (value && (ANOMALY_WINDOWS as readonly string[]).includes(value)) {
    return value as AnomalyWindow;
  }
  return '5m';
}
