import { buildClusterView, emptyClusterView } from './platform-cluster';
import type { InstantRow } from '../dashboard/telemetry.client';

function row(metric: Record<string, string>, value: number): InstantRow {
  return { metric, value };
}

describe('buildClusterView', () => {
  it('marca el clúster como no disponible si no hay señal de Kubernetes', () => {
    expect(
      buildClusterView({
        nodeInfo: [],
        nodeReady: [],
        nodeUnschedulable: [],
        nodeCpuAlloc: [],
        nodeMemAlloc: [],
        nodeCpuUsed: [],
        nodeMemUsed: [],
        podPhases: [],
        platformPodPhases: [],
        deploymentsDesired: [],
        deploymentsAvailable: [],
        daemonsetsDesired: [],
        daemonsetsReady: [],
        statefulsetsDesired: [],
        statefulsetsReady: [],
        waitingReasons: [],
      }),
    ).toEqual(emptyClusterView());
  });

  it('correlaciona nodos, pods y cargas de la plataforma', () => {
    const view = buildClusterView({
      nodeInfo: [
        row(
          {
            node: 'worker-a',
            kubelet_version: 'v1.33.2',
            os_image: 'Ubuntu 24.04',
          },
          1,
        ),
      ],
      nodeReady: [row({ node: 'worker-a' }, 1)],
      nodeUnschedulable: [row({ node: 'worker-a' }, 0)],
      nodeCpuAlloc: [row({ node: 'worker-a', resource: 'cpu' }, 4)],
      nodeMemAlloc: [row({ node: 'worker-a', resource: 'memory' }, 8_000_000_000)],
      nodeCpuUsed: [row({ instance: 'worker-a' }, 0.42)],
      nodeMemUsed: [row({ instance: 'worker-a' }, 0.61)],
      podPhases: [
        row({ phase: 'Running' }, 12),
        row({ phase: 'Pending' }, 1),
        row({ phase: 'Failed' }, 0),
      ],
      platformPodPhases: [row({ phase: 'Running', namespace: 'ekumetrics' }, 8)],
      deploymentsDesired: [
        row({ namespace: 'ekumetrics', deployment: 'platform-api' }, 1),
      ],
      deploymentsAvailable: [
        row({ namespace: 'ekumetrics', deployment: 'platform-api' }, 1),
      ],
      daemonsetsDesired: [
        row({ namespace: 'ekumetrics', daemonset: 'node-exporter' }, 1),
      ],
      daemonsetsReady: [
        row({ namespace: 'ekumetrics', daemonset: 'node-exporter' }, 1),
      ],
      statefulsetsDesired: [],
      statefulsetsReady: [],
      waitingReasons: [
        row(
          {
            namespace: 'ekumetrics',
            pod: 'holmes-0',
            reason: 'CrashLoopBackOff',
          },
          1,
        ),
      ],
    });

    expect(view.available).toBe(true);
    expect(view.kubeletVersion).toBe('v1.33.2');
    expect(view.nodesReady).toBe(1);
    expect(view.nodesTotal).toBe(1);
    expect(view.pods).toMatchObject({ running: 12, pending: 1, failed: 0 });
    expect(view.platformPods.running).toBe(8);
    expect(view.nodes[0]).toMatchObject({
      name: 'worker-a',
      ready: true,
      cpuUsed: 0.42,
      memUsed: 0.61,
    });
    expect(view.workloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'DaemonSet', name: 'node-exporter', desired: 1, ready: 1 }),
        expect.objectContaining({ kind: 'Deployment', name: 'platform-api', desired: 1, ready: 1 }),
      ]),
    );
    expect(view.issues).toEqual([
      { namespace: 'ekumetrics', pod: 'holmes-0', reason: 'CrashLoopBackOff' },
    ]);
  });
});
