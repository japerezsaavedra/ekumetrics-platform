import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { walk, type GraphLink } from './graph-walk';

export type NeighborFact = {
  siteId: string;
  fromKey: string;
  fromName?: string;
  fromKind?: string;
  toKey: string;
  toName?: string;
  toKind?: string;
  source: string;
  seenAt: Date;
};

@Injectable()
export class GraphService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertNeighbor(tenantId: string, fact: NeighborFact): Promise<void> {
    const source = fact.source || 'lldp';
    await this.touchNode(tenantId, {
      siteId: fact.siteId,
      nodeKey: fact.fromKey,
      kind: fact.fromKind || 'device',
      name: fact.fromName || fact.fromKey,
      source,
      lastSeenAt: fact.seenAt,
    });
    await this.touchNode(tenantId, {
      siteId: fact.siteId,
      nodeKey: fact.toKey,
      kind: fact.toKind || 'device',
      name: fact.toName || fact.toKey,
      source,
      lastSeenAt: fact.seenAt,
    });
    await this.prisma.graphEdge.upsert({
      where: {
        tenantId_fromKey_toKey_relation_source: {
          tenantId,
          fromKey: fact.fromKey,
          toKey: fact.toKey,
          relation: 'CONNECTS_TO',
          source,
        },
      },
      create: {
        tenantId,
        siteId: fact.siteId,
        fromKey: fact.fromKey,
        toKey: fact.toKey,
        relation: 'CONNECTS_TO',
        source,
        lastSeenAt: fact.seenAt,
      },
      update: { lastSeenAt: fact.seenAt, siteId: fact.siteId },
    });
  }

  async links(tenantId: string, siteId?: string): Promise<GraphLink[]> {
    const rows = await this.prisma.graphEdge.findMany({
      where: { tenantId, ...(siteId ? { siteId } : {}) },
      select: { fromKey: true, toKey: true },
    });
    return rows;
  }

  async impact(tenantId: string, nodeKey: string, hops = 3) {
    const node = await this.prisma.graphNode.findUnique({
      where: { tenantId_nodeKey: { tenantId, nodeKey } },
    });
    const edges = await this.links(tenantId, node?.siteId);
    const keys = [...walk(nodeKey, edges, hops)];
    const nodes = await this.prisma.graphNode.findMany({
      where: { tenantId, nodeKey: { in: keys } },
      orderBy: { name: 'asc' },
    });
    return {
      origin: node,
      hops,
      nodes: nodes.map((item) => ({
        key: item.nodeKey,
        kind: item.kind,
        name: item.name,
        siteId: item.siteId,
      })),
    };
  }

  async nodeByKey(tenantId: string, nodeKey: string) {
    return this.prisma.graphNode.findUnique({
      where: { tenantId_nodeKey: { tenantId, nodeKey } },
    });
  }

  async matchNode(tenantId: string, siteId: string | undefined, hint: string) {
    if (!hint) return null;
    const direct = await this.prisma.graphNode.findUnique({
      where: { tenantId_nodeKey: { tenantId, nodeKey: hint } },
    });
    if (direct) return direct;
    if (siteId) {
      const keyed = await this.prisma.graphNode.findUnique({
        where: {
          tenantId_nodeKey: { tenantId, nodeKey: `site/${siteId}/ip/${hint}` },
        },
      });
      if (keyed) return keyed;
    }
    return this.prisma.graphNode.findFirst({
      where: {
        tenantId,
        ...(siteId ? { siteId } : {}),
        OR: [{ name: hint }, { nodeKey: { endsWith: `/${hint}` } }],
      },
    });
  }

  private async touchNode(
    tenantId: string,
    node: {
      siteId: string;
      nodeKey: string;
      kind: string;
      name: string;
      source: string;
      lastSeenAt: Date;
    },
  ) {
    await this.prisma.graphNode.upsert({
      where: { tenantId_nodeKey: { tenantId, nodeKey: node.nodeKey } },
      create: { tenantId, ...node },
      update: {
        lastSeenAt: node.lastSeenAt,
        kind: node.kind,
        name: node.name,
        siteId: node.siteId,
      },
    });
  }
}
