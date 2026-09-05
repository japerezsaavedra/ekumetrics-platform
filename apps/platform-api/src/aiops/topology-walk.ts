import {
  TOPOLOGY_DEPENDENCY_RELATIONS,
  TOPOLOGY_HOSTING_RELATIONS,
} from './topology.relations';
import type { TopologyQueryOptions } from './topology.repository';

export type TopologyWalkEdge = {
  fromKey: string;
  toKey: string;
  relation: string;
};

const DEPENDENCY = new Set<string>(TOPOLOGY_DEPENDENCY_RELATIONS);
const HOSTING = new Set<string>(TOPOLOGY_HOSTING_RELATIONS);

export function matchesRole(
  entityKey: string,
  edge: TopologyWalkEdge,
  role: 'dependencies' | 'dependents',
  options?: TopologyQueryOptions,
): boolean {
  const custom = options?.relations?.length ? new Set(options.relations) : null;
  if (custom && !custom.has(edge.relation)) return false;
  const dependency = custom
    ? custom.has(edge.relation)
    : DEPENDENCY.has(edge.relation);
  const hosting = custom
    ? custom.has(edge.relation)
    : HOSTING.has(edge.relation);
  if (role === 'dependencies') {
    if (
      edge.fromKey === entityKey &&
      dependency &&
      !HOSTING.has(edge.relation)
    ) {
      return true;
    }
    return edge.toKey === entityKey && hosting;
  }
  if (edge.toKey === entityKey && dependency && !HOSTING.has(edge.relation)) {
    return true;
  }
  return edge.fromKey === entityKey && hosting;
}

export function roleNeighbor(
  entityKey: string,
  edge: TopologyWalkEdge,
  role: 'dependencies' | 'dependents',
): string {
  if (role === 'dependencies') {
    return edge.fromKey === entityKey ? edge.toKey : edge.fromKey;
  }
  return edge.toKey === entityKey ? edge.fromKey : edge.toKey;
}

export function directedNeighbors(
  key: string,
  edges: TopologyWalkEdge[],
  role: 'dependencies' | 'dependents',
  options?: TopologyQueryOptions,
): string[] {
  const next = new Set<string>();
  for (const edge of edges) {
    if (!matchesRole(key, edge, role, options)) continue;
    next.add(roleNeighbor(key, edge, role));
  }
  return [...next];
}

export function walkDirected(
  start: string,
  edges: TopologyWalkEdge[],
  hops: number,
  role: 'dependencies' | 'dependents',
  options?: TopologyQueryOptions,
): string[] {
  const seen = new Set<string>([start]);
  const ordered: string[] = [];
  let frontier = [start];
  for (let depth = 0; depth < hops; depth += 1) {
    const following: string[] = [];
    for (const node of frontier) {
      for (const neighbor of directedNeighbors(node, edges, role, options)) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        ordered.push(neighbor);
        following.push(neighbor);
      }
    }
    frontier = following;
  }
  return ordered;
}

export function ancestorDistances(
  start: string,
  edges: TopologyWalkEdge[],
  hops: number,
  options?: TopologyQueryOptions,
): Map<string, number> {
  const distances = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  for (let depth = 0; depth < hops; depth += 1) {
    const following: string[] = [];
    for (const node of frontier) {
      for (const neighbor of directedNeighbors(
        node,
        edges,
        'dependencies',
        options,
      )) {
        if (distances.has(neighbor)) continue;
        distances.set(neighbor, depth + 1);
        following.push(neighbor);
      }
    }
    frontier = following;
  }
  return distances;
}

export function pickClosest(
  candidates: string[],
  distances: Map<string, number>[],
): string | null {
  let best: string | null = null;
  let bestMax = Number.POSITIVE_INFINITY;
  let bestSum = Number.POSITIVE_INFINITY;
  for (const key of candidates) {
    const values = distances.map(
      (map) => map.get(key) ?? Number.POSITIVE_INFINITY,
    );
    const max = Math.max(...values);
    const sum = values.reduce((total, value) => total + value, 0);
    if (max < bestMax || (max === bestMax && sum < bestSum)) {
      best = key;
      bestMax = max;
      bestSum = sum;
    }
  }
  return best;
}

export function undirectedNeighbors(
  key: string,
  edges: TopologyWalkEdge[],
  options?: TopologyQueryOptions,
): string[] {
  const allowed = options?.relations?.length
    ? new Set(options.relations)
    : null;
  const next = new Set<string>();
  for (const edge of edges) {
    if (allowed && !allowed.has(edge.relation)) continue;
    if (edge.fromKey === key) next.add(edge.toKey);
    if (edge.toKey === key) next.add(edge.fromKey);
  }
  return [...next];
}

export function shortestPath(
  fromKey: string,
  toKey: string,
  edges: TopologyWalkEdge[],
  hops: number,
  options?: TopologyQueryOptions,
): string[] | null {
  if (fromKey === toKey) return [fromKey];
  const parent = new Map<string, string | null>([[fromKey, null]]);
  let frontier = [fromKey];
  for (let depth = 0; depth < hops; depth += 1) {
    const following: string[] = [];
    for (const node of frontier) {
      for (const neighbor of undirectedNeighbors(node, edges, options)) {
        if (parent.has(neighbor)) continue;
        parent.set(neighbor, node);
        if (neighbor === toKey) return reconstruct(parent, toKey);
        following.push(neighbor);
      }
    }
    frontier = following;
  }
  return parent.has(toKey) ? reconstruct(parent, toKey) : null;
}

export function relatedWithinHops<T extends TopologyWalkEdge>(
  start: string,
  edges: T[],
  hops: number,
  options?: TopologyQueryOptions,
): Array<{ key: string; edge: T; viaKey: string }> {
  if (hops <= 0) return [];
  const found: Array<{ key: string; edge: T; viaKey: string }> = [];
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let depth = 0; depth < hops; depth += 1) {
    const following: string[] = [];
    for (const node of frontier) {
      for (const edge of edges) {
        if (
          options?.relations?.length &&
          !options.relations.includes(edge.relation)
        ) {
          continue;
        }
        const neighbor =
          edge.fromKey === node
            ? edge.toKey
            : edge.toKey === node
              ? edge.fromKey
              : null;
        if (!neighbor || seen.has(neighbor)) continue;
        seen.add(neighbor);
        found.push({ key: neighbor, edge, viaKey: node });
        following.push(neighbor);
      }
    }
    frontier = following;
  }
  return found;
}

function reconstruct(
  parent: Map<string, string | null>,
  end: string,
): string[] {
  const path = [end];
  let current: string | null = end;
  while (current) {
    const key: string = current;
    const previous: string | null = parent.get(key) ?? null;
    if (!previous) break;
    path.push(previous);
    current = previous;
  }
  return path.reverse();
}
