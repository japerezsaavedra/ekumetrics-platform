import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assertTenantScope, TenantScopeError } from '../persistence/tenant-scope.error';
import type { IncidentEnrichment } from './incident-enrichment.types';
import type { IncidentEnrichmentRepository } from './incident-enrichment.repository';

@Injectable()
export class PrismaIncidentEnrichmentRepository
  implements IncidentEnrichmentRepository
{
  constructor(private readonly prisma: PrismaService) {}

  async save(enrichment: IncidentEnrichment): Promise<IncidentEnrichment> {
    assertTenantScope(enrichment.tenantId);
    if (!enrichment.incidentId) {
      throw new Error('incidentId es obligatorio.');
    }
    const existing = await this.prisma.incidentEnrichment.findUnique({
      where: { incidentId: enrichment.incidentId },
    });
    if (existing && existing.tenantId !== enrichment.tenantId) {
      throw new TenantScopeError();
    }
    const data = {
      tenantId: enrichment.tenantId,
      incidentId: enrichment.incidentId,
      primaryRootCause: enrichment.primaryRootCause?.entityKey ?? null,
      rcaConfidence: enrichment.rcaConfidence,
      affectedServiceCount: enrichment.affectedServices.length,
      affectedEntities: enrichment.affectedEntities as unknown as Prisma.InputJsonValue,
      affectedServices: enrichment.affectedServices as unknown as Prisma.InputJsonValue,
      blastRadius: enrichment.blastRadius as unknown as Prisma.InputJsonValue,
      topologyEvidence: enrichment.topologyEvidence as unknown as Prisma.InputJsonValue,
      anomalies: enrichment.anomalies as unknown as Prisma.InputJsonValue,
      rootCauseCandidates:
        enrichment.rootCauseCandidates as unknown as Prisma.InputJsonValue,
      correlationEvidence:
        enrichment.correlationEvidence as unknown as Prisma.InputJsonValue,
      timeline: enrichment.timeline as unknown as Prisma.InputJsonValue,
      recentChanges: enrichment.recentChanges as unknown as Prisma.InputJsonValue,
      historicalMatches:
        enrichment.historicalMatches as unknown as Prisma.InputJsonValue,
      snapshot: enrichment as unknown as Prisma.InputJsonValue,
    };
    if (existing) {
      await this.prisma.incidentEnrichment.update({
        where: { id: existing.id },
        data,
      });
    } else {
      await this.prisma.incidentEnrichment.create({ data });
    }
    return enrichment;
  }

  async findByIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<IncidentEnrichment | null> {
    assertTenantScope(tenantId);
    const row = await this.prisma.incidentEnrichment.findFirst({
      where: { tenantId, incidentId },
    });
    if (!row || row.tenantId !== tenantId) return null;
    return fromRow(row);
  }

  async findByIncidentIds(
    tenantId: string,
    incidentIds: readonly string[],
  ): Promise<Map<string, IncidentEnrichment>> {
    assertTenantScope(tenantId);
    const result = new Map<string, IncidentEnrichment>();
    if (incidentIds.length === 0) return result;
    const rows = await this.prisma.incidentEnrichment.findMany({
      where: { tenantId, incidentId: { in: [...incidentIds] } },
    });
    for (const row of rows) {
      if (row.tenantId !== tenantId) continue;
      const mapped = fromRow(row);
      if (mapped) result.set(row.incidentId, mapped);
    }
    return result;
  }
}

function fromRow(row: {
  tenantId: string;
  incidentId: string;
  snapshot: unknown;
}): IncidentEnrichment | null {
  if (row.snapshot && typeof row.snapshot === 'object') {
    const snapshot = row.snapshot as IncidentEnrichment;
    if (snapshot.tenantId !== row.tenantId) return null;
    return snapshot;
  }
  return null;
}
