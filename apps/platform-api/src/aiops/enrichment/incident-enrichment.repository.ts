import { Injectable } from '@nestjs/common';
import { assertTenantScope } from '../persistence/tenant-scope.error';
import type { IncidentEnrichment } from './incident-enrichment.types';

export const INCIDENT_ENRICHMENT_REPOSITORY = Symbol(
  'INCIDENT_ENRICHMENT_REPOSITORY',
);

export interface IncidentEnrichmentRepository {
  save(enrichment: IncidentEnrichment): Promise<IncidentEnrichment>;
  findByIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<IncidentEnrichment | null>;
  findByIncidentIds(
    tenantId: string,
    incidentIds: readonly string[],
  ): Promise<Map<string, IncidentEnrichment>>;
}

function storeKey(tenantId: string, incidentId: string): string {
  return `${tenantId}:${incidentId}`;
}

/**
 * Store in-memory para tests. Producción usa PrismaIncidentEnrichmentRepository.
 */
@Injectable()
export class InMemoryIncidentEnrichmentRepository
  implements IncidentEnrichmentRepository
{
  private readonly rows = new Map<string, IncidentEnrichment>();

  save(enrichment: IncidentEnrichment): Promise<IncidentEnrichment> {
    assertTenantScope(enrichment.tenantId);
    if (!enrichment.incidentId) {
      throw new Error('incidentId es obligatorio.');
    }
    const copy: IncidentEnrichment = {
      ...enrichment,
      affectedEntities: [...enrichment.affectedEntities],
      affectedServices: [...enrichment.affectedServices],
      anomalies: [...enrichment.anomalies],
      rootCauseCandidates: [...enrichment.rootCauseCandidates],
      correlationEvidence: [...enrichment.correlationEvidence],
      timeline: [...enrichment.timeline],
      recentChanges: [...enrichment.recentChanges],
      historicalMatches: [...enrichment.historicalMatches],
      operatorFeedback: [...enrichment.operatorFeedback],
    };
    this.rows.set(storeKey(enrichment.tenantId, enrichment.incidentId), copy);
    return Promise.resolve(copy);
  }

  findByIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<IncidentEnrichment | null> {
    assertTenantScope(tenantId);
    const row = this.rows.get(storeKey(tenantId, incidentId));
    if (!row || row.tenantId !== tenantId) return Promise.resolve(null);
    return Promise.resolve(row);
  }

  findByIncidentIds(
    tenantId: string,
    incidentIds: readonly string[],
  ): Promise<Map<string, IncidentEnrichment>> {
    assertTenantScope(tenantId);
    const result = new Map<string, IncidentEnrichment>();
    for (const incidentId of incidentIds) {
      const row = this.rows.get(storeKey(tenantId, incidentId));
      if (row && row.tenantId === tenantId) {
        result.set(incidentId, row);
      }
    }
    return Promise.resolve(result);
  }
}
