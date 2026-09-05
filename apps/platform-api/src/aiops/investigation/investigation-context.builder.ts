import { Injectable } from '@nestjs/common';
import type { IncidentEnrichment } from '../enrichment/incident-enrichment.types';
import type { InvestigationContext } from '../types/aiops-investigation';

type IncidentRow = {
  id: string;
  tenantId: string;
  title: string;
  severity: string;
  siteId: string | null;
  causeKey: string | null;
  windowStart: Date | string | null;
  windowEnd: Date | string | null;
  members?: unknown;
};

@Injectable()
export class InvestigationContextBuilder {
  build(
    incident: IncidentRow,
    enrichment: IncidentEnrichment | null,
    tenantSlug?: string,
  ): InvestigationContext {
    const entities = enrichment?.affectedEntities ?? [];
    const services = enrichment?.affectedServices ?? [];
    const anomalies = enrichment?.anomalies ?? [];
    const blast = enrichment?.blastRadius;
    const primary = enrichment?.primaryRootCause;
    const firstEntity = entities[0];
    return {
      tenantId: incident.tenantId,
      incidentId: incident.id,
      tenantSlug,
      siteId: incident.siteId ?? undefined,
      title: incident.title,
      severity: incident.severity,
      causeKey: incident.causeKey ?? primary?.entityKey ?? undefined,
      entityKey: firstEntity?.entityKey ?? incident.causeKey ?? undefined,
      entityType: firstEntity?.kind,
      affectedEntityKinds: [
        ...entities.map((item) => item.kind),
        ...services.map((item) => item.kind),
      ].filter(Boolean),
      anomalies: anomalies.map((item) => `${item.kind} ${item.summary}`),
      anomalySummaries: anomalies.map((item) => ({
        summary: item.summary,
        kind: item.kind,
        entityKey: item.entityKey,
      })),
      needsBlastRadius: Boolean(blast && blast.entityCount > 0),
      blastEntityKeys: blast?.entityKeys ?? [],
      blastRadius: blast
        ? {
            hops: blast.hops,
            entityCount: blast.entityCount,
            entityKeys: blast.entityKeys,
          }
        : undefined,
      affectedEntities: entities.map((item) => ({
        entityKey: item.entityKey,
        kind: item.kind,
        name: item.name,
      })),
      affectedServices: services.map((item) => ({
        entityKey: item.entityKey,
        kind: item.kind,
        name: item.name,
      })),
      windowStart: toIso(incident.windowStart),
      windowEnd: toIso(incident.windowEnd),
      topologySummary: enrichment?.topologyEvidence
        ?.map((item) => item.statement)
        .slice(0, 8)
        .join('; '),
      timeline: enrichment?.timeline?.slice(0, 20).map((item) => ({
        occurredAt: item.occurredAt,
        summary: item.summary,
      })),
      historicalMatches: enrichment?.historicalMatches
        ?.slice(0, 5)
        .map((item) => ({
          incidentId: item.incidentId,
          title: item.title,
        })),
      deterministicRca: enrichment
        ? {
            rcaMode: enrichment.rcaMode,
            confidence: enrichment.rcaConfidence,
            hypothesis: primary?.hypothesis,
            entityKey: primary?.entityKey,
            candidates: (enrichment.rootCauseCandidates ?? [])
              .slice(0, 8)
              .map((item) => ({
                entityKey: item.entityKey,
                hypothesis: item.hypothesis,
                confidence: item.confidence,
                rank: item.rank,
              })),
          }
        : undefined,
    };
  }
}

function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  return value;
}
