import type { InstantRow } from '../dashboard/telemetry.client';

export const PLATFORM_NAMESPACE = 'ekumetrics';

export type ClusterPodCounts = {
  running: number;
  pending: number;
  failed: number;
  succeeded: number;
  unknown: number;
};

export type ClusterNode = {
  name: string;
  ready: boolean;
  unschedulable: boolean;
  kubeletVersion: string | null;
  osImage: string | null;
  cpuAllocatable: number | null;
  memoryAllocatableBytes: number | null;
  cpuUsed: number | null;
  memUsed: number | null;
};

export type ClusterWorkload = {
  kind: 'Deployment' | 'DaemonSet' | 'StatefulSet';
  name: string;
  namespace: string;
  desired: number;
  ready: number;
};

export type ClusterPodIssue = {
  namespace: string;
  pod: string;
  reason: string;
};

export type ClusterView = {
  available: boolean;
  namespace: string;
  kubeletVersion: string | null;
  nodesReady: number;
  nodesTotal: number;
  pods: ClusterPodCounts;
  platformPods: ClusterPodCounts;
  nodes: ClusterNode[];
  workloads: ClusterWorkload[];
  issues: ClusterPodIssue[];
};

const EMPTY_PODS: ClusterPodCounts = {
  running: 0,
  pending: 0,
  failed: 0,
  succeeded: 0,
  unknown: 0,
};

export function emptyClusterView(): ClusterView {
  return {
    available: false,
    namespace: PLATFORM_NAMESPACE,
    kubeletVersion: null,
    nodesReady: 0,
    nodesTotal: 0,
    pods: { ...EMPTY_PODS },
    platformPods: { ...EMPTY_PODS },
    nodes: [],
    workloads: [],
    issues: [],
  };
}

export function buildClusterView(input: {
  nodeInfo: InstantRow[];
  nodeReady: InstantRow[];
  nodeUnschedulable: InstantRow[];
  nodeCpuAlloc: InstantRow[];
  nodeMemAlloc: InstantRow[];
  nodeCpuUsed: InstantRow[];
  nodeMemUsed: InstantRow[];
  podPhases: InstantRow[];
  platformPodPhases: InstantRow[];
  deploymentsDesired: InstantRow[];
  deploymentsAvailable: InstantRow[];
  daemonsetsDesired: InstantRow[];
  daemonsetsReady: InstantRow[];
  statefulsetsDesired: InstantRow[];
  statefulsetsReady: InstantRow[];
  waitingReasons: InstantRow[];
}): ClusterView {
  if (input.nodeInfo.length === 0 && input.podPhases.length === 0) {
    return emptyClusterView();
  }
  const readyByNode = byNode(input.nodeReady);
  const unschedulableByNode = byNode(input.nodeUnschedulable);
  const cpuAllocByNode = byNode(input.nodeCpuAlloc);
  const memAllocByNode = byNode(input.nodeMemAlloc);
  const cpuUsedByNode = byInstance(input.nodeCpuUsed);
  const memUsedByNode = byInstance(input.nodeMemUsed);
  const nodes = input.nodeInfo
    .map((row) => {
      const name = row.metric.node ?? row.metric.instance ?? '';
      if (!name) return null;
      return {
        name,
        ready: (readyByNode.get(name) ?? 0) === 1,
        unschedulable: (unschedulableByNode.get(name) ?? 0) === 1,
        kubeletVersion: row.metric.kubelet_version || null,
        osImage: row.metric.os_image || null,
        cpuAllocatable: cpuAllocByNode.get(name) ?? null,
        memoryAllocatableBytes: memAllocByNode.get(name) ?? null,
        cpuUsed: cpuUsedByNode.get(name) ?? null,
        memUsed: memUsedByNode.get(name) ?? null,
      } satisfies ClusterNode;
    })
    .filter((node): node is ClusterNode => node !== null)
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const versions = nodes
    .map((node) => node.kubeletVersion)
    .filter((value): value is string => Boolean(value));
  const workloads = [
    ...joinWorkloads('Deployment', 'deployment', input.deploymentsDesired, input.deploymentsAvailable),
    ...joinWorkloads('DaemonSet', 'daemonset', input.daemonsetsDesired, input.daemonsetsReady),
    ...joinWorkloads('StatefulSet', 'statefulset', input.statefulsetsDesired, input.statefulsetsReady),
  ].sort((left, right) => {
    const byKind = left.kind.localeCompare(right.kind, 'es');
    return byKind !== 0 ? byKind : left.name.localeCompare(right.name, 'en');
  });
  const issues = input.waitingReasons
    .filter((row) => row.value === 1)
    .map((row) => ({
      namespace: row.metric.namespace ?? PLATFORM_NAMESPACE,
      pod: row.metric.pod ?? '',
      reason: row.metric.reason ?? 'Waiting',
    }))
    .filter((item) => item.pod.length > 0)
    .sort((left, right) => left.pod.localeCompare(right.pod, 'en'));
  return {
    available: true,
    namespace: PLATFORM_NAMESPACE,
    kubeletVersion: versions[0] ?? null,
    nodesReady: nodes.filter((node) => node.ready).length,
    nodesTotal: nodes.length,
    pods: countPhases(input.podPhases),
    platformPods: countPhases(input.platformPodPhases),
    nodes,
    workloads,
    issues,
  };
}

function countPhases(rows: InstantRow[]): ClusterPodCounts {
  const counts = { ...EMPTY_PODS };
  for (const row of rows) {
    const phase = (row.metric.phase ?? 'unknown').toLowerCase();
    const value = Number.isFinite(row.value) ? row.value : 0;
    if (phase === 'running') counts.running += value;
    else if (phase === 'pending') counts.pending += value;
    else if (phase === 'failed') counts.failed += value;
    else if (phase === 'succeeded') counts.succeeded += value;
    else counts.unknown += value;
  }
  return counts;
}

function joinWorkloads(
  kind: ClusterWorkload['kind'],
  nameLabel: string,
  desiredRows: InstantRow[],
  readyRows: InstantRow[],
): ClusterWorkload[] {
  const ready = new Map<string, number>();
  for (const row of readyRows) {
    ready.set(workloadKey(row, nameLabel), row.value);
  }
  return desiredRows
    .map((row) => {
      const name = row.metric[nameLabel] ?? '';
      if (!name) return null;
      const namespace = row.metric.namespace ?? PLATFORM_NAMESPACE;
      return {
        kind,
        name,
        namespace,
        desired: row.value,
        ready: ready.get(workloadKey(row, nameLabel)) ?? 0,
      } satisfies ClusterWorkload;
    })
    .filter((item): item is ClusterWorkload => item !== null);
}

function workloadKey(row: InstantRow, nameLabel: string): string {
  return `${row.metric.namespace ?? ''}/${row.metric[nameLabel] ?? ''}`;
}

function byNode(rows: InstantRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const name = row.metric.node;
    if (name) map.set(name, row.value);
  }
  return map;
}

function byInstance(rows: InstantRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const name = row.metric.instance ?? row.metric.node;
    if (name) map.set(name, row.value);
  }
  return map;
}
