import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GraphService } from '../graph.service';
import type {
  RcaCollectorEvent,
  RcaGraphEdge,
  RcaGraphNode,
  RcaIncidentRecord,
} from './types';

export const RCA_INCIDENT_SOURCE = 'RcaIncidentSource';

export type RcaGraphSnapshot = {
  nodes: RcaGraphNode[];
  edges: RcaGraphEdge[];
};

export interface RcaIncidentSource {
  getIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<RcaIncidentRecord | null>;
  getCollectorEvents(
    tenantId: string,
    fingerprints: string[],
  ): Promise<RcaCollectorEvent[]>;
  getGraph(tenantId: string, siteId?: string | null): Promise<RcaGraphSnapshot>;
}

@Injectable()
export class PrismaRcaIncidentSource implements RcaIncidentSource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
  ) {}

  async getIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<RcaIncidentRecord | null> {
    if (!tenantId || !incidentId) return null;
    const row = await this.prisma.incident.findFirst({
      where: { id: incidentId, tenantId },
      select: {
        id: true,
        tenantId: true,
        siteId: true,
        clusterKey: true,
        causeKey: true,
        causeName: true,
        windowStart: true,
        windowEnd: true,
        members: true,
        title: true,
      },
    });
    return row;
  }

  async getCollectorEvents(
    tenantId: string,
    fingerprints: string[],
  ): Promise<RcaCollectorEvent[]> {
    const keys = fingerprints.filter(Boolean);
    if (!tenantId || keys.length === 0) return [];
    const rows = await this.prisma.agentEvent.findMany({
      where: { tenantId, fingerprint: { in: keys } },
      select: {
        fingerprint: true,
        signal: true,
        assetKey: true,
        entityType: true,
        eventAt: true,
        metadata: true,
      },
    });
    return rows.map((row) => ({
      fingerprint: row.fingerprint,
      signal: row.signal,
      assetKey: row.assetKey,
      entityType: row.entityType,
      eventAt: row.eventAt,
      summary: summaryFromMetadata(row.metadata),
    }));
  }

  async getGraph(
    tenantId: string,
    siteId?: string | null,
  ): Promise<RcaGraphSnapshot> {
    if (!tenantId) return { nodes: [], edges: [] };
    const site = siteId || undefined;
    const [nodes, edges] = await Promise.all([
      this.graph.listNodes(tenantId, { siteId: site }),
      this.graph.listEdges(tenantId, { siteId: site }),
    ]);
    return {
      nodes: nodes.map((node) => ({
        entityKey: node.nodeKey,
        kind: node.kind,
        name: node.name,
        tenantId: node.tenantId,
      })),
      edges: edges.map((edge) => ({
        fromKey: edge.fromKey,
        toKey: edge.toKey,
        relation: edge.relation,
        tenantId: edge.tenantId,
      })),
    };
  }
}

function summaryFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const summary = (metadata as { summary?: unknown }).summary;
  return typeof summary === 'string' ? summary : undefined;
}
