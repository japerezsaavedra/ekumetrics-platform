export type GraphLink = { fromKey: string; toKey: string };

export function adjacent(key: string, edges: GraphLink[]): string[] {
  const next = new Set<string>();
  for (const edge of edges) {
    if (edge.fromKey === key) next.add(edge.toKey);
    if (edge.toKey === key) next.add(edge.fromKey);
  }
  return [...next];
}

export function walk(start: string, edges: GraphLink[], hops: number): Set<string> {
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let depth = 0; depth < hops; depth += 1) {
    const following: string[] = [];
    for (const node of frontier) {
      for (const neighbor of adjacent(node, edges)) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        following.push(neighbor);
      }
    }
    frontier = following;
  }
  return seen;
}

export function sharePath(
  left: string,
  right: string,
  edges: GraphLink[],
  hops: number,
): boolean {
  if (left === right) return true;
  return walk(left, edges, hops).has(right);
}

export function commonCover(
  keys: string[],
  edges: GraphLink[],
  hops: number,
): string | null {
  if (keys.length === 0) return null;
  const unique = [...new Set(keys)];
  const scores = new Map<string, number>();
  for (const key of unique) {
    for (const node of walk(key, edges, hops)) {
      scores.set(node, (scores.get(node) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestScore = 0;
  let bestReach = -1;
  let bestDegree = -1;
  for (const [node, score] of scores) {
    if (score < unique.length) continue;
    const reach = walk(node, edges, hops).size;
    const degree = adjacent(node, edges).length;
    if (
      score > bestScore ||
      (score === bestScore && reach > bestReach) ||
      (score === bestScore && reach === bestReach && degree > bestDegree)
    ) {
      best = node;
      bestScore = score;
      bestReach = reach;
      bestDegree = degree;
    }
  }
  return best;
}
