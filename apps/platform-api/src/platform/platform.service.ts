import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryClient } from '../dashboard/telemetry.client';
import {
  DEFAULT_PLATFORM_THRESHOLDS,
  mergePlatformThresholds,
  type PlatformThresholds,
} from './platform-thresholds';
import { PLATFORM_NAMESPACE, buildClusterView, emptyClusterView } from './platform-cluster';

const RANGE_SECONDS = 3600;
const RANGE_STEP = 30;
const FS = 'ext4|xfs|btrfs|zfs';
const NET = 'eth0|enp.*|ens.*|eno.*';

const SERVICE_LABELS: Record<string, string> = {
  'platform-api': 'API',
  'node-exporter': 'Host',
  'kube-state-metrics': 'Kubernetes',
  prometheus: 'Prometheus',
  tempo: 'Tempo',
  'otel-collector': 'OTLP',
};

@Injectable()
export class PlatformService {
  constructor(
    private readonly telemetry: TelemetryClient,
    private readonly prisma: PrismaService,
  ) {}

  async overview() {
    const [host, cluster, services, slo, api, series, logs, traces, thresholds] = await Promise.all([
      this.hostSnapshot(),
      this.clusterSnapshot(),
      this.services(),
      this.sloSnapshot(),
      this.apiSnapshot(),
      this.seriesSnapshot(),
      this.logLines(),
      this.traceItems(),
      this.thresholds('platform'),
    ]);
    return {
      host,
      cluster,
      services,
      slo: { ...slo, saturation: this.saturationFrom(host) },
      api,
      series,
      logs,
      traces,
      thresholds,
      updatedAt: new Date().toISOString(),
    };
  }

  async thresholds(scope: string, tenantSlug?: string): Promise<PlatformThresholds> {
    try {
      const slot = await this.thresholdSlot(scope, tenantSlug);
      const row = await this.prisma.platformThresholds.findUnique({
        where: { slot },
      });
      return mergePlatformThresholds(row?.values);
    } catch {
      return { ...DEFAULT_PLATFORM_THRESHOLDS };
    }
  }

  async saveThresholds(
    scope: string,
    input: unknown,
    tenantSlug?: string,
  ): Promise<PlatformThresholds> {
    const next = mergePlatformThresholds(input);
    const pairs: Array<[keyof PlatformThresholds, keyof PlatformThresholds]> = [
      ['availabilityWarn', 'availabilityCrit'],
      ['errorBudgetWarn', 'errorBudgetCrit'],
      ['latencyWarn', 'latencyCrit'],
      ['freshnessWarn', 'freshnessCrit'],
      ['saturationWarn', 'saturationCrit'],
      ['cpuWarn', 'cpuCrit'],
      ['memWarn', 'memCrit'],
      ['diskWarn', 'diskCrit'],
      ['netWarn', 'netCrit'],
      ['errorsWarn', 'errorsCrit'],
      ['p95Warn', 'p95Crit'],
    ];
    for (const [warn, crit] of pairs) {
      if (next[warn] > next[crit]) {
        throw new BadRequestException('El aviso no puede superar el crítico.');
      }
    }
    const slot = await this.thresholdSlot(scope, tenantSlug);
    const tenantId = slot.startsWith('agents:') ? slot.slice('agents:'.length) : null;
    const values = next as Prisma.InputJsonValue;
    await this.prisma.platformThresholds.upsert({
      where: { slot },
      create: { slot, tenantId, values },
      update: { values },
    });
    return next;
  }

  private async thresholdSlot(scope: string, tenantSlug?: string): Promise<string> {
    if (scope === 'platform') {
      return 'platform';
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: (tenantSlug ?? '').trim() || 'default' },
      select: { id: true },
    });
    if (!tenant) {
      throw new NotFoundException('El tenant no existe.');
    }
    return `agents:${tenant.id}`;
  }

  private saturationFrom(host: {
    cpus: number | null;
    load1: number | null;
    cpuUsed: number | null;
    memUsed: number | null;
    diskUsed: number | null;
  }) {
    const cpu =
      host.cpus && host.cpus > 0 && host.load1 !== null
        ? host.load1 / host.cpus
        : host.cpuUsed;
    const memory = host.memUsed;
    const disk = host.diskUsed;
    const parts = [
      { key: 'cpu' as const, value: cpu },
      { key: 'memoria' as const, value: memory },
      { key: 'disco' as const, value: disk },
    ].filter((item): item is { key: 'cpu' | 'memoria' | 'disco'; value: number } => item.value !== null);
    const worst = parts.reduce<{ key: 'cpu' | 'memoria' | 'disco'; value: number } | null>(
      (current, item) => (!current || item.value > current.value ? item : current),
      null,
    );
    return {
      value: worst?.value ?? null,
      cpu,
      memory,
      disk,
      driver: worst?.key ?? null,
    };
  }

  private async clusterSnapshot() {
    try {
      const [
        nodeInfo,
        nodeReady,
        nodeUnschedulable,
        nodeCpuAlloc,
        nodeMemAlloc,
        nodeCpuUsed,
        nodeMemUsed,
        podPhases,
        platformPodPhases,
        deploymentsDesired,
        deploymentsAvailable,
        daemonsetsDesired,
        daemonsetsReady,
        statefulsetsDesired,
        statefulsetsReady,
        waitingReasons,
      ] = await Promise.all([
        this.rows('kube_node_info'),
        this.rows('kube_node_status_condition{condition="Ready",status="true"}'),
        this.rows('kube_node_spec_unschedulable'),
        this.rows('kube_node_status_allocatable{resource="cpu"}'),
        this.rows('kube_node_status_allocatable{resource="memory"}'),
        this.rows('1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))'),
        this.rows('1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes'),
        this.rows('count by (phase) (kube_pod_status_phase == 1)'),
        this.rows(`count by (phase) (kube_pod_status_phase{namespace="${PLATFORM_NAMESPACE}"} == 1)`),
        this.rows(`kube_deployment_spec_replicas{namespace="${PLATFORM_NAMESPACE}"}`),
        this.rows(`kube_deployment_status_replicas_available{namespace="${PLATFORM_NAMESPACE}"}`),
        this.rows(`kube_daemonset_status_desired_number_scheduled{namespace="${PLATFORM_NAMESPACE}"}`),
        this.rows(`kube_daemonset_status_number_ready{namespace="${PLATFORM_NAMESPACE}"}`),
        this.rows(`kube_statefulset_replicas{namespace="${PLATFORM_NAMESPACE}"}`),
        this.rows(`kube_statefulset_status_replicas_ready{namespace="${PLATFORM_NAMESPACE}"}`),
        this.rows(`kube_pod_container_status_waiting_reason{namespace="${PLATFORM_NAMESPACE}"} == 1`),
      ]);
      return buildClusterView({
        nodeInfo,
        nodeReady,
        nodeUnschedulable,
        nodeCpuAlloc,
        nodeMemAlloc,
        nodeCpuUsed,
        nodeMemUsed,
        podPhases,
        platformPodPhases,
        deploymentsDesired,
        deploymentsAvailable,
        daemonsetsDesired,
        daemonsetsReady,
        statefulsetsDesired,
        statefulsetsReady,
        waitingReasons,
      });
    } catch {
      return emptyClusterView();
    }
  }

  private async hostSnapshot() {
    const [uname, os, uptime, cpus, load1, load5, load15, cpuUsed, memUsed, memTotal, memAvail, swapUsed, diskUsed, diskAvail, diskSize, netRxRows, netTxRows, netErrs, netDrops, diskRead, diskWrite, tcpEstab] =
      await Promise.all([
        this.rows('node_uname_info'),
        this.rows('node_os_info'),
        this.num('node_time_seconds - node_boot_time_seconds'),
        this.num('count(node_cpu_seconds_total{mode="idle"})'),
        this.num('node_load1'),
        this.num('node_load5'),
        this.num('node_load15'),
        this.num('1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))'),
        this.num('1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes'),
        this.num('node_memory_MemTotal_bytes'),
        this.num('node_memory_MemAvailable_bytes'),
        this.num('(node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes) / clamp_min(node_memory_SwapTotal_bytes, 1)'),
        this.num(`max(1 - node_filesystem_avail_bytes{fstype=~"${FS}"} / node_filesystem_size_bytes{fstype=~"${FS}"})`),
        this.num(`max(node_filesystem_avail_bytes{fstype=~"${FS}"})`),
        this.num(`max(node_filesystem_size_bytes{fstype=~"${FS}"})`),
        this.rows(`rate(node_network_receive_bytes_total{device=~"${NET}"}[5m])`),
        this.rows(`rate(node_network_transmit_bytes_total{device=~"${NET}"}[5m])`),
        this.num('sum(rate(node_network_receive_errs_total[5m])) + sum(rate(node_network_transmit_errs_total[5m]))'),
        this.num('sum(rate(node_network_receive_drop_total[5m])) + sum(rate(node_network_transmit_drop_total[5m]))'),
        this.num('sum(rate(node_disk_read_bytes_total[5m]))'),
        this.num('sum(rate(node_disk_written_bytes_total[5m]))'),
        this.num('node_netstat_Tcp_CurrEstab'),
      ]);
    const rxByDevice = new Map(
      netRxRows.map((row) => [row.metric.device ?? '', row.value]),
    );
    const txByDevice = new Map(
      netTxRows.map((row) => [row.metric.device ?? '', row.value]),
    );
    const nics = [...new Set([...rxByDevice.keys(), ...txByDevice.keys()])]
      .filter((device) => device.length > 0)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((device) => ({
        device,
        rxBytesPerSec: rxByDevice.get(device) ?? null,
        txBytesPerSec: txByDevice.get(device) ?? null,
      }));
    const netRx = nics.reduce((sum, nic) => sum + (nic.rxBytesPerSec ?? 0), 0);
    const netTx = nics.reduce((sum, nic) => sum + (nic.txBytesPerSec ?? 0), 0);
    const identity = uname[0]?.metric ?? {};
    return {
      hostname: identity.nodename ?? null,
      os: os[0]?.metric?.pretty_name ?? identity.sysname ?? null,
      kernel: identity.release ?? null,
      arch: identity.machine ?? null,
      uptimeSeconds: uptime,
      cpus,
      load1,
      load5,
      load15,
      cpuUsed,
      memUsed,
      memTotalBytes: memTotal,
      memAvailBytes: memAvail,
      swapUsed,
      diskUsed,
      diskAvailBytes: diskAvail,
      diskTotalBytes: diskSize,
      nics,
      netRxBytesPerSec: nics.length ? netRx : null,
      netTxBytesPerSec: nics.length ? netTx : null,
      netErrorsPerSec: netErrs,
      netDropsPerSec: netDrops,
      diskReadBytesPerSec: diskRead,
      diskWriteBytesPerSec: diskWrite,
      tcpEstablished: tcpEstab,
    };
  }

  private async services() {
    const rows = await this.rows('up');
    return rows
      .map((row) => ({
        job: row.metric.job ?? row.metric.instance ?? 'unknown',
        instance: row.metric.instance ?? '',
        label: SERVICE_LABELS[row.metric.job ?? ''] ?? row.metric.job ?? 'Servicio',
        up: row.value === 1,
      }))
      .sort((left, right) => left.label.localeCompare(right.label, 'es'));
  }

  private async sloSnapshot() {
    const [availability, errorBudget, latency, freshness] = await Promise.all([
      this.num('ekumetrics:api_availability:ratio_rate5m'),
      this.num(
        'clamp_min((1 - ekumetrics:api_availability:ratio_rate5m) / (1 - 0.999), 0)',
      ),
      this.num('ekumetrics:api_latency_under_500ms:ratio_rate5m'),
      this.num('ekumetrics:agents_fresh:ratio'),
    ]);
    return { availability, errorBudget, latency, freshness };
  }

  private async apiSnapshot() {
    const [rps, errors, p95] = await Promise.all([
      this.num('sum(rate(ekumetrics_http_requests_total{route!~"/metrics|/health.*"}[5m]))'),
      this.num(`
        (sum(rate(ekumetrics_http_requests_total{route!~"/metrics|/health.*",status_code=~"5.."}[5m])) or vector(0))
        /
        clamp_min(sum(rate(ekumetrics_http_requests_total{route!~"/metrics|/health.*"}[5m])) or vector(0), 0.000001)
      `),
      this.num(
        'histogram_quantile(0.95, sum by (le) (rate(ekumetrics_http_request_duration_seconds_bucket{route!~"/metrics|/health.*"}[5m])))',
      ),
    ]);
    return { requestsPerSec: rps, errorRatio: errors, p95Seconds: p95 };
  }

  private async seriesSnapshot() {
    const [cpu, memory, disk, netRx, netTx, rps] = await Promise.all([
      this.range('1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))'),
      this.range('1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes'),
      this.range(`max(1 - node_filesystem_avail_bytes{fstype=~"${FS}"} / node_filesystem_size_bytes{fstype=~"${FS}"})`),
      this.range(`sum(rate(node_network_receive_bytes_total{device=~"${NET}"}[5m]))`),
      this.range(`sum(rate(node_network_transmit_bytes_total{device=~"${NET}"}[5m]))`),
      this.range('sum(rate(ekumetrics_http_requests_total{route!~"/metrics|/health.*"}[5m]))'),
    ]);
    return { cpu, memory, disk, netRx, netTx, rps };
  }

  async queryLogs(from?: string, to?: string) {
    try {
      const endMs = to ? Date.parse(to) : Date.now();
      const parsedStart = from ? Date.parse(from) : endMs - RANGE_SECONDS * 1000;
      if (!Number.isFinite(endMs) || !Number.isFinite(parsedStart) || parsedStart >= endMs) {
        return [];
      }
      const startMs = Math.max(parsedStart, endMs - 7 * 86_400_000);
      const window = Math.ceil((endMs - startMs) / 1000);
      const k8s = await this.telemetry.lokiLines(
        '{namespace="ekumetrics"}',
        window,
        500,
        { startMs, endMs },
      );
      if (k8s.length > 0) {
        return k8s;
      }
      return await this.telemetry.lokiLines(
        '{job="platform-host"}',
        window,
        500,
        { startMs, endMs },
      );
    } catch {
      return [];
    }
  }

  async queryTraces(from?: string, to?: string, operation?: string) {
    try {
      const endMs = to ? Date.parse(to) : Date.now();
      const parsedStart = from ? Date.parse(from) : endMs - RANGE_SECONDS * 1000;
      if (!Number.isFinite(endMs) || !Number.isFinite(parsedStart) || parsedStart >= endMs) {
        return [];
      }
      const startMs = Math.max(parsedStart, endMs - 7 * 86_400_000);
      const window = Math.ceil((endMs - startMs) / 1000);
      return await this.telemetry.tempoSearch(
        this.traceQuery(operation),
        window,
        100,
        10,
        { startMs, endMs },
      );
    } catch {
      return [];
    }
  }

  async getTrace(traceId: string) {
    try {
      return await this.telemetry.tempoTrace(traceId);
    } catch {
      return null;
    }
  }

  private traceQuery(operation?: string): string {
    const base = '{ resource.service.name = "ekumetrics-platform-api" }';
    const op = (operation ?? '').trim().slice(0, 200);
    if (!op || op === 'todas' || !/^[\w ./:+-]+$/.test(op)) {
      return base;
    }
    return `{ resource.service.name = "ekumetrics-platform-api" && name = "${op}" }`;
  }

  private async logLines() {
    return this.queryLogs();
  }

  private async traceItems() {
    try {
      return await this.telemetry.tempoSearch(
        '{ resource.service.name = "ekumetrics-platform-api" }',
        RANGE_SECONDS,
        20,
        10,
      );
    } catch {
      return [];
    }
  }

  private async num(query: string): Promise<number | null> {
    try {
      return this.telemetry.first(await this.telemetry.instant(query));
    } catch {
      return null;
    }
  }

  private async rows(query: string) {
    try {
      return await this.telemetry.instant(query);
    } catch {
      return [];
    }
  }

  private async range(query: string) {
    try {
      const series = await this.telemetry.range(query, RANGE_SECONDS, RANGE_STEP);
      return series[0]?.values ?? [];
    } catch {
      return [];
    }
  }
}
