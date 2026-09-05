import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GRAPH_EXAMPLE_EDGES, GRAPH_EXAMPLE_NODES } from './graph-example';
import { walk, type GraphLink } from './graph-walk';
import { TOPOLOGY_RELATIONS } from './topology.relations';

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

export type RelationFact = NeighborFact & {
  relation: string;
  confidence?: number | null;
};

export type GraphEdgeFilter = {
  siteId?: string;
  fromKey?: string;
  toKey?: string;
  neighborKey?: string;
  relations?: readonly string[];
};

@Injectable()
export class GraphService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertNeighbor(tenantId: string, fact: NeighborFact): Promise<void> {
    await this.upsertRelation(tenantId, {
      ...fact,
      relation: TOPOLOGY_RELATIONS.CONNECTS_TO,
    });
  }

  async upsertRelation(tenantId: string, fact: RelationFact): Promise<void> {
    const source = fact.source || 'lldp';
    const relation = fact.relation || TOPOLOGY_RELATIONS.CONNECTS_TO;
    const confidence =
      fact.confidence === undefined || fact.confidence === null
        ? undefined
        : Math.min(1, Math.max(0, fact.confidence));
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
          relation,
          source,
        },
      },
      create: {
        tenantId,
        siteId: fact.siteId,
        fromKey: fact.fromKey,
        toKey: fact.toKey,
        relation,
        source,
        lastSeenAt: fact.seenAt,
        ...(confidence !== undefined ? { confidence } : {}),
      },
      update: {
        lastSeenAt: fact.seenAt,
        siteId: fact.siteId,
        ...(fact.confidence !== undefined
          ? { confidence: confidence ?? null }
          : {}),
      },
    });
  }

  async listNodes(
    tenantId: string,
    opts: { keys?: string[]; siteId?: string } = {},
  ) {
    if (opts.keys && opts.keys.length === 0) return [];
    return this.prisma.graphNode.findMany({
      where: {
        tenantId,
        ...(opts.siteId ? { siteId: opts.siteId } : {}),
        ...(opts.keys ? { nodeKey: { in: opts.keys } } : {}),
      },
    });
  }

  async listEdges(tenantId: string, filter: GraphEdgeFilter = {}) {
    return this.prisma.graphEdge.findMany({
      where: {
        tenantId,
        ...(filter.siteId ? { siteId: filter.siteId } : {}),
        ...(filter.fromKey ? { fromKey: filter.fromKey } : {}),
        ...(filter.toKey ? { toKey: filter.toKey } : {}),
        ...(filter.neighborKey
          ? {
              OR: [
                { fromKey: filter.neighborKey },
                { toKey: filter.neighborKey },
              ],
            }
          : {}),
        ...(filter.relations?.length
          ? { relation: { in: [...filter.relations] } }
          : {}),
      },
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
    const keySet = new Set(keys);
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
      edges: edges
        .filter((edge) => keySet.has(edge.fromKey) && keySet.has(edge.toKey))
        .map((edge) => ({ from: edge.fromKey, to: edge.toKey })),
    };
  }

  async snapshot(tenantId: string, siteId?: string) {
    const where = { tenantId, ...(siteId ? { siteId } : {}) };
    const [nodes, edges] = await Promise.all([
      this.prisma.graphNode.findMany({
        where,
        orderBy: [{ siteId: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.graphEdge.findMany({
        where,
        orderBy: [{ fromKey: 'asc' }, { toKey: 'asc' }],
      }),
    ]);
    const sites = [...new Set(nodes.map((item) => item.siteId))].sort();
    return {
      sites,
      nodes: nodes.map((item) => ({
        key: item.nodeKey,
        name: item.name,
        kind: item.kind,
        siteId: item.siteId,
        source: item.source,
        lastSeenAt: item.lastSeenAt,
      })),
      edges: edges.map((item) => ({
        from: item.fromKey,
        to: item.toKey,
        relation: item.relation,
        source: item.source,
        siteId: item.siteId,
        confidence: item.confidence,
        firstSeenAt: item.createdAt,
        lastSeenAt: item.lastSeenAt,
      })),
    };
  }

  async seedExample(tenantId: string, siteId: string) {
    const seenAt = new Date();
    const byKey = new Map(GRAPH_EXAMPLE_NODES.map((item) => [item.key, item]));
    for (const edge of GRAPH_EXAMPLE_EDGES) {
      const from = byKey.get(edge.fromKey);
      const to = byKey.get(edge.toKey);
      if (!from || !to) continue;
      await this.upsertNeighbor(tenantId, {
        siteId,
        fromKey: from.key,
        fromName: from.name,
        fromKind: from.kind,
        toKey: to.key,
        toName: to.name,
        toKind: to.kind,
        source: 'example',
        seenAt,
      });
    }
    return this.snapshot(tenantId, siteId);
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
