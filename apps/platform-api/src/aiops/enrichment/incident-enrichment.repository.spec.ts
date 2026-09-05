import { TenantScopeError } from '../persistence/tenant-scope.error';
import { InMemoryIncidentEnrichmentRepository } from './incident-enrichment.repository';
import {
  INCIDENT_ENRICHMENT_ALGORITHM,
  INCIDENT_ENRICHMENT_SCHEMA_VERSION,
  INCIDENT_ENRICHMENT_SOURCE,
  type IncidentEnrichment,
} from './incident-enrichment.types';

function enrichment(
  tenantId: string,
  incidentId: string,
): IncidentEnrichment {
  return {
    tenantId,
    incidentId,
    schemaVersion: INCIDENT_ENRICHMENT_SCHEMA_VERSION,
    algorithm: INCIDENT_ENRICHMENT_ALGORITHM,
    source: INCIDENT_ENRICHMENT_SOURCE,
    score: 0.5,
    confidence: 0.5,
    evidence: [],
    computedPriority: {
      level: 'P3',
      score: 0.4,
      confidence: 0.8,
      algorithm: 'weighted_priority_v1',
      source: 'IncidentPriorityCalculator',
      evidence: [],
      factors: [],
    },
    affectedEntities: [],
    affectedServices: [],
    blastRadius: {
      originKey: null,
      hops: 3,
      entityCount: 0,
      entityKeys: [],
      score: 0,
      confidence: 0.4,
      algorithm: 'graph_impact_walk',
      source: 'graph.impact',
      evidence: [],
    },
    topologyEvidence: [],
    anomalies: [],
    rootCauseCandidates: [],
    primaryRootCause: null,
    rcaConfidence: null,
    correlationEvidence: [],
    timeline: [],
    recentChanges: [],
    historicalMatches: [],
    operatorFeedback: [],
    rcaMode: 'correlation_fallback',
    aiInvestigationStatus: 'not_executed',
    enrichedAt: '2026-09-05T10:00:00.000Z',
  };
}

describe('InMemoryIncidentEnrichmentRepository tenant isolation', () => {
  it('no permite leer enrichment de otro tenant', async () => {
    const store = new InMemoryIncidentEnrichmentRepository();
    await store.save(enrichment('tenant-a', 'inc-1'));
    const own = await store.findByIncident('tenant-a', 'inc-1');
    const other = await store.findByIncident('tenant-b', 'inc-1');
    expect(own?.tenantId).toBe('tenant-a');
    expect(other).toBeNull();
  });

  it('findByIncidentIds solo devuelve filas del tenant pedido', async () => {
    const store = new InMemoryIncidentEnrichmentRepository();
    await store.save(enrichment('tenant-a', 'inc-1'));
    await store.save(enrichment('tenant-b', 'inc-1'));
    const map = await store.findByIncidentIds('tenant-a', ['inc-1']);
    expect(map.get('inc-1')?.tenantId).toBe('tenant-a');
    expect(map.size).toBe(1);
  });

  it('rechaza tenantId vacio', () => {
    const store = new InMemoryIncidentEnrichmentRepository();
    expect(() => {
      void store.findByIncident('', 'inc-1');
    }).toThrow(TenantScopeError);
  });
});
