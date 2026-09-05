import { Injectable } from '@nestjs/common';
import { GraphService } from './graph.service';
import { commonCover, type GraphLink } from './graph-walk';
import {
  ancestorDistances,
  matchesRole,
  pickClosest,
  relatedWithinHops,
  roleNeighbor,
  shortestPath,
  walkDirected,
} from './topology-walk';
import { TOPOLOGY_DEFAULT_HOPS } from './topology.relations';
import type {
  RelatedEntity,
  TopologyEntity,
  TopologyQueryOptions,
  TopologyRelationship,
  TopologyRepository,
} from './topology.repository';

type NodeRow = {
  id: string;
  tenantId: string;
  siteId: string;
  nodeKey: string;
  kind: string;
  name: string;
  source: string;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type EdgeRow = {
  id: string;
  tenantId: string;
  siteId: string;
  fromKey: string;
  toKey: string;
  relation: string;
  source: string;
  confidence: number | null;
  lastSeenAt: Date;
  createdAt: Date;
};

@Injectable()
export class PostgresTopologyRepository implements TopologyRepository {
  constructor(private readonly graph: GraphService) {}

  async getEntity(
    tenantId: string,
    entityKey: string,
  ): Promise<TopologyEntity | null> {
    if (!entityKey) return null;
    const node = await this.graph.nodeByKey(tenantId, entityKey);
    return node ? toEntity(node) : null;
  }

  async getDependencies(
    tenantId: string,
    entityKey: string,
    options?: TopologyQueryOptions,
  ): Promise<RelatedEntity[]> {
    return this.relatedByRole(tenantId, entityKey, 'dependencies', options);
  }

  async getDependents(
    tenantId: string,
    entityKey: string,
    options?: TopologyQueryOptions,
  ): Promise<RelatedEntity[]> {
    return this.relatedByRole(tenantId, entityKey, 'dependents', options);
  }

  async getAncestors(
    tenantId: string,
    entityKey: string,
    options?: TopologyQueryOptions,
  ): Promise<TopologyEntity[]> {
    const hops = options?.hops ?? TOPOLOGY_DEFAULT_HOPS;
    const edges = await this.loadGraph(tenantId, options);
    const keys = walkDirected(entityKey, edges, hops, 'dependencies', options);
    return this.hydrate(tenantId, keys, options?.siteId);
  }

  async getDescendants(
    tenantId: string,
    entityKey: string,
    options?: TopologyQueryOptions,
  ): Promise<TopologyEntity[]> {
    const hops = options?.hops ?? TOPOLOGY_DEFAULT_HOPS;
    const edges = await this.loadGraph(tenantId, options);
    const keys = walkDirected(entityKey, edges, hops, 'dependents', options);
    return this.hydrate(tenantId, keys, options?.siteId);
  }

  async getPath(
    tenantId: string,
    fromKey: string,
    toKey: string,
    options?: TopologyQueryOptions,
  ): Promise<TopologyEntity[] | null> {
    if (!fromKey || !toKey) return null;
    const hops = options?.hops ?? TOPOLOGY_DEFAULT_HOPS;
    if (fromKey === toKey) {
      const origin = await this.getEntity(tenantId, fromKey);
      return origin ? [origin] : null;
    }
    const edges = await this.loadGraph(tenantId, options);
    const path = shortestPath(fromKey, toKey, edges, hops, options);
    if (!path) return null;
    const nodes = await this.hydrate(tenantId, path, options?.siteId);
    const byKey = new Map(nodes.map((item) => [item.entityKey, item]));
    const ordered = path
      .map((key) => byKey.get(key))
      .filter((item): item is TopologyEntity => Boolean(item));
    return ordered.length === path.length ? ordered : null;
  }

  async getCommonAncestor(
    tenantId: string,
    entityKeys: string[],
    options?: TopologyQueryOptions,
  ): Promise<TopologyEntity | null> {
    const unique = [...new Set(entityKeys.filter(Boolean))];
    if (unique.length === 0) return null;
    if (unique.length === 1) return this.getEntity(tenantId, unique[0]);

    const hops = options?.hops ?? TOPOLOGY_DEFAULT_HOPS;
    const edges = await this.loadGraph(tenantId, options);
    const distances = unique.map((key) =>
      ancestorDistances(key, edges, hops, options),
    );
    const candidates = [...distances[0].keys()].filter((key) =>
      distances.every((map) => map.has(key)),
    );
    if (candidates.length > 0) {
      const best = pickClosest(candidates, distances);
      return best ? this.getEntity(tenantId, best) : null;
    }

    const links: GraphLink[] = edges.map((edge) => ({
      fromKey: edge.fromKey,
      toKey: edge.toKey,
    }));
    const cover = commonCover(unique, links, hops);
    return cover ? this.getEntity(tenantId, cover) : null;
  }

  async findRelatedEntities(
    tenantId: string,
    entityKey: string,
    options?: TopologyQueryOptions,
  ): Promise<RelatedEntity[]> {
    if (!entityKey) return [];
    const hops = options?.hops ?? 1;
    const origin = await this.getEntity(tenantId, entityKey);
    if (!origin) return [];
    const edges = await this.loadGraph(tenantId, options);
    const found = relatedWithinHops(entityKey, edges, hops, options);
    const nodes = await this.hydrate(
      tenantId,
      found.map((item) => item.key),
      options?.siteId,
    );
    const byKey = new Map(nodes.map((item) => [item.entityKey, item]));
    const related: RelatedEntity[] = [];
    for (const item of found) {
      const entity = byKey.get(item.key);
      if (!entity) continue;
      related.push({
        entity,
        relationship: toRelationship(item.edge),
        direction: item.edge.fromKey === item.viaKey ? 'outgoing' : 'incoming',
      });
    }
    return related;
  }

  private async relatedByRole(
    tenantId: string,
    entityKey: string,
    role: 'dependencies' | 'dependents',
    options?: TopologyQueryOptions,
  ): Promise<RelatedEntity[]> {
    if (!entityKey) return [];
    const edges = await this.loadGraph(tenantId, options);
    const matched = edges.filter((edge) =>
      matchesRole(entityKey, edge, role, options),
    );
    const neighborKeys = matched.map((edge) =>
      roleNeighbor(entityKey, edge, role),
    );
    const nodes = await this.hydrate(tenantId, neighborKeys, options?.siteId);
    const byKey = new Map(nodes.map((item) => [item.entityKey, item]));
    const related: RelatedEntity[] = [];
    for (const edge of matched) {
      const neighborKey = roleNeighbor(entityKey, edge, role);
      const entity = byKey.get(neighborKey);
      if (!entity) continue;
      related.push({
        entity,
        relationship: toRelationship(edge),
        direction: edge.fromKey === entityKey ? 'outgoing' : 'incoming',
      });
    }
    return related;
  }

  private async loadGraph(tenantId: string, options?: TopologyQueryOptions) {
    return this.graph.listEdges(tenantId, {
      siteId: options?.siteId,
      relations: options?.relations,
    });
  }

  private async hydrate(
    tenantId: string,
    keys: string[],
    siteId?: string,
  ): Promise<TopologyEntity[]> {
    const unique = [...new Set(keys.filter(Boolean))];
    if (unique.length === 0) return [];
    const nodes = await this.graph.listNodes(tenantId, {
      keys: unique,
      siteId,
    });
    const order = new Map(unique.map((key, index) => [key, index]));
    return nodes
      .map(toEntity)
      .sort(
        (left, right) =>
          (order.get(left.entityKey) ?? 0) - (order.get(right.entityKey) ?? 0),
      );
  }
}

function toEntity(node: NodeRow): TopologyEntity {
  return {
    id: node.id,
    tenantId: node.tenantId,
    siteId: node.siteId,
    entityKey: node.nodeKey,
    kind: node.kind,
    name: node.name,
    source: node.source,
    lastSeenAt: node.lastSeenAt,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

function toRelationship(edge: EdgeRow): TopologyRelationship {
  return {
    id: edge.id,
    tenantId: edge.tenantId,
    siteId: edge.siteId,
    fromKey: edge.fromKey,
    toKey: edge.toKey,
    relation: edge.relation,
    source: edge.source,
    confidence: edge.confidence,
    firstSeenAt: edge.createdAt,
    lastSeenAt: edge.lastSeenAt,
  };
}
