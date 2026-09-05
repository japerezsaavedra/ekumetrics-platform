export type TopologyNode = {
  key: string;
  name: string;
  kind: string;
  siteId: string;
  source?: string;
  lastSeenAt?: string;
};

export type TopologyEdge = {
  from: string;
  to: string;
};

export type TopologyLevel = {
  depth: number;
  label: string;
  nodes: TopologyNode[];
};

export function adjacency(edges: TopologyEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const next = map.get(from) ?? [];
    if (!next.includes(to)) next.push(to);
    map.set(from, next);
  };
  for (const edge of edges) {
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }
  return map;
}

export function walkKeys(start: string, edges: TopologyEdge[], hops: number): Set<string> {
  const adj = adjacency(edges);
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let depth = 0; depth < hops; depth += 1) {
    const following: string[] = [];
    for (const key of frontier) {
      for (const neighbor of adj.get(key) ?? []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        following.push(neighbor);
      }
    }
    frontier = following;
  }
  return seen;
}

export function shortestPath(
  start: string,
  goal: string,
  edges: TopologyEdge[],
): string[] | null {
  if (start === goal) return [start];
  const adj = adjacency(edges);
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    for (const neighbor of adj.get(current) ?? []) {
      if (parent.has(neighbor)) continue;
      parent.set(neighbor, current);
      if (neighbor === goal) {
        const path = [goal];
        let cursor: string | null = goal;
        while (cursor && cursor !== start) {
          cursor = parent.get(cursor) ?? null;
          if (cursor) path.push(cursor);
        }
        return path.reverse();
      }
      queue.push(neighbor);
    }
  }
  return null;
}

export function depthLevels(
  root: string | null,
  nodes: TopologyNode[],
  edges: TopologyEdge[],
): TopologyLevel[] {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  if (!root || !byKey.has(root)) {
    return nodes.length
      ? [{ depth: 0, label: 'Topología', nodes: [...nodes] }]
      : [];
  }
  const adj = adjacency(edges);
  const depth = new Map<string, number>([[root, 0]]);
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    if (current == null) break;
    const currentDepth = depth.get(current) ?? 0;
    for (const neighbor of adj.get(current) ?? []) {
      if (depth.has(neighbor)) continue;
      depth.set(neighbor, currentDepth + 1);
      queue.push(neighbor);
    }
  }
  const grouped = new Map<number, TopologyNode[]>();
  for (const [key, hop] of depth) {
    const node = byKey.get(key);
    if (!node) continue;
    const list = grouped.get(hop) ?? [];
    list.push(node);
    grouped.set(hop, list);
  }
  const levels: TopologyLevel[] = [...grouped.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([hop, levelNodes]) => ({
      depth: hop,
      label: hopLabel(hop),
      nodes: levelNodes.sort((left, right) => left.name.localeCompare(right.name)),
    }));
  const reached = new Set(depth.keys());
  const outside = nodes.filter((node) => !reached.has(node.key));
  if (outside.length) {
    levels.push({
      depth: 99,
      label: 'Sin camino a la causa',
      nodes: outside.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }
  return levels;
}

function hopLabel(hop: number): string {
  if (hop === 0) return 'Causa';
  if (hop === 1) return 'A 1 salto';
  return `A ${hop} saltos`;
}
