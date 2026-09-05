import {
  TOPOLOGY_DEFAULT_HOPS,
  TOPOLOGY_DEPENDENCY_RELATIONS,
  TOPOLOGY_HOSTING_RELATIONS,
  TOPOLOGY_RELATIONS,
  TOPOLOGY_UNDIRECTED_RELATIONS,
  isTopologyRelation,
  type TopologyRelation,
} from './topology.relations';

export {
  TOPOLOGY_DEFAULT_HOPS,
  TOPOLOGY_DEPENDENCY_RELATIONS,
  TOPOLOGY_HOSTING_RELATIONS,
  TOPOLOGY_RELATIONS,
  TOPOLOGY_UNDIRECTED_RELATIONS,
  isTopologyRelation,
};
export type { TopologyRelation };

export const TOPOLOGY_REPOSITORY = Symbol('TOPOLOGY_REPOSITORY');

export type TopologyEntity = {
  id: string;
  tenantId: string;
  siteId: string;
  entityKey: string;
  kind: string;
  name: string;
  source: string;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type TopologyRelationship = {
  id: string;
  tenantId: string;
  siteId: string;
  fromKey: string;
  toKey: string;
  relation: string;
  source: string;
  confidence: number | null;
  /** Maps to GraphEdge.createdAt (no extra column). */
  firstSeenAt: Date;
  lastSeenAt: Date;
};

export type RelatedEntity = {
  entity: TopologyEntity;
  relationship: TopologyRelationship;
  direction: 'outgoing' | 'incoming';
};

export type TopologyQueryOptions = {
  siteId?: string;
  relations?: readonly string[];
  hops?: number;
};

export type TopologyPath = TopologyEntity[];

export interface TopologyRepository {
  getEntity(
    tenantId: string,
    entityKey: string,
  ): Promise<TopologyEntity | null>;
  getDependencies(
    tenantId: string,
    entityKey: string,
    options?: TopologyQueryOptions,
  ): Promise<RelatedEntity[]>;
  getDependents(
    tenantId: string,
    entityKey: string,
    options?: TopologyQueryOptions,
  ): Promise<RelatedEntity[]>;
  getAncestors(
    tenantId: string,
    entityKey: string,
    options?: TopologyQueryOptions,
  ): Promise<TopologyEntity[]>;
  getDescendants(
    tenantId: string,
    entityKey: string,
    options?: TopologyQueryOptions,
  ): Promise<TopologyEntity[]>;
  getPath(
    tenantId: string,
    fromKey: string,
    toKey: string,
    options?: TopologyQueryOptions,
  ): Promise<TopologyPath | null>;
  getCommonAncestor(
    tenantId: string,
    entityKeys: string[],
    options?: TopologyQueryOptions,
  ): Promise<TopologyEntity | null>;
  findRelatedEntities(
    tenantId: string,
    entityKey: string,
    options?: TopologyQueryOptions,
  ): Promise<RelatedEntity[]>;
}
