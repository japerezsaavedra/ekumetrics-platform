import { ForbiddenException, Injectable } from '@nestjs/common';
import { PlatformService } from '../platform/platform.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantsService } from '../tenants/tenants.service';
import {
  applyTenantModuleFilter,
  dashboardViewModule,
  parseStoredModules,
  tenantHasModule,
  type OptionalTenantModule,
} from '../tenants/tenant-modules';
import { TelemetryClient, type InstantRow } from './telemetry.client';

export type DashboardHost = {
  id: string;
  siteId: string | null;
  tenantId: string | null;
  mode: string | null;
  version: string | null;
  online: boolean | null;
  cpuUsed: number | null;
  memoryUsed: number | null;
  uptimeSeconds: number | null;
  agentUptimeSeconds: number | null;
  cpus: number | null;
};

export type DashboardNic = {
  hostId: string;
  siteId: string | null;
  device: string;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  errorsPerSec: number;
  dropsPerSec: number;
};

export type DashboardDatabase = {
  hostId: string;
  siteId: string | null;
  engine: string;
  name: string;
  up: boolean;
};

export type DashboardTarget = DashboardDatabase;

export type DashboardIcewarpService = {
  name: string;
  running: boolean;
  uptimeSeconds: number | null;
  sessions: number | null;
  sessionsPeak: number | null;
  workingSetBytes: number | null;
};

export type DashboardIcewarpProbe = {
  name: string;
  endpoint: string;
  up: boolean;
  rttSeconds: number | null;
};

export type DashboardIcewarp = {
  hostId: string | null;
  name: string;
  servicesUp: number;
  servicesTotal: number;
  sessions: number | null;
  smtpIn: number | null;
  smtpOut: number | null;
  smtpFailed: number | null;
  rejected: number | null;
  services: DashboardIcewarpService[];
  probes: DashboardIcewarpProbe[];
  series: {
    sessions: Array<{ state: string; values: Array<[number, number]> }>;
    memory: Array<{ state: string; values: Array<[number, number]> }>;
    smtp: Array<{ state: string; values: Array<[number, number]> }>;
    defense: Array<{ state: string; values: Array<[number, number]> }>;
    probesRtt: Array<{ state: string; values: Array<[number, number]> }>;
  };
};

@Injectable()
export class DashboardService {
  constructor(
    private readonly telemetry: TelemetryClient,
    private readonly prisma: PrismaService,
    private readonly tenants: TenantsService,
    private readonly platform: PlatformService,
  ) {}

  async getInventory(tenantInput?: string, siteInput?: string) {
    const tenantSlug = this.sanitize(tenantInput);
    const siteSlug = this.sanitize(siteInput);
    if (!tenantSlug) return this.emptyInventory();
    const modules = await this.modulesFor(tenantSlug);
    const [hosts, nics, databases, networkDevices, queues, icewarp, sap] =
      await Promise.all([
        this.listHosts(tenantSlug),
        this.listNics(tenantSlug),
        this.optionalInventory(modules, 'databases', () =>
          this.listDatabases(tenantSlug),
        ),
        this.optionalInventory(modules, 'network', () =>
          this.listNetworkDevices(tenantSlug),
        ),
        this.optionalInventory(modules, 'queues', () =>
          this.listQueues(tenantSlug),
        ),
        this.optionalInventory(modules, 'icewarp', () =>
          this.listIcewarp(tenantSlug),
        ),
        this.optionalInventory(modules, 'sap', () => this.listSap(tenantSlug)),
      ]);
    const inSite = <T extends { siteId: string | null }>(items: T[]) =>
      items.filter((item) => !siteSlug || item.siteId === siteSlug);
    return applyTenantModuleFilter(
      {
        hosts: inSite(hosts),
        nics: inSite(nics),
        databases: inSite(databases),
        networkDevices: inSite(networkDevices),
        queues: inSite(queues),
        icewarp: inSite(icewarp),
        sap: inSite(sap),
      },
      modules,
    );
  }

  private emptyInventory() {
    return {
      hosts: [] as DashboardHost[],
      nics: [] as DashboardNic[],
      databases: [] as DashboardDatabase[],
      networkDevices: [] as DashboardTarget[],
      queues: [] as DashboardTarget[],
      icewarp: [] as DashboardTarget[],
      sap: [] as DashboardTarget[],
    };
  }

  private async modulesFor(tenantSlug?: string) {
    if (!tenantSlug) {
      return [];
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { modules: true },
    });
    return parseStoredModules(tenant?.modules);
  }

  private optionalInventory<T>(
    modules: unknown,
    id: OptionalTenantModule,
    load: () => Promise<T[]>,
  ): Promise<T[]> {
    return tenantHasModule(modules, id) ? load() : Promise.resolve([]);
  }

  async getDashboard(
    agentIdInput?: string,
    rangeInput?: string,
    tenantInput?: string,
    viewInput?: string,
    siteInput?: string,
  ) {
    const window = this.windowFor(rangeInput);
    const tenantSlug = this.sanitize(tenantInput);
    const siteSlug = this.sanitize(siteInput);
    const tenantModules = await this.modulesFor(tenantSlug);
    const viewModule = dashboardViewModule(viewInput);
    if (viewModule && !tenantHasModule(tenantModules, viewModule)) {
      throw new ForbiddenException('Este tenant no tiene ese modulo.');
    }
    const rawHosts = (await this.listHosts(tenantSlug)).filter(
      (item) => !siteSlug || item.siteId === siteSlug,
    );
    const [
      hosts,
      allNics,
      allDatabases,
      allNetworkDevices,
      allQueues,
      allIcewarp,
      allSap,
    ] = await Promise.all([
      this.enrichHosts(rawHosts),
      this.listNics(tenantSlug),
      this.optionalInventory(tenantModules, 'databases', () =>
        this.listDatabases(tenantSlug),
      ),
      this.optionalInventory(tenantModules, 'network', () =>
        this.listNetworkDevices(tenantSlug),
      ),
      this.optionalInventory(tenantModules, 'queues', () =>
        this.listQueues(tenantSlug),
      ),
      this.optionalInventory(tenantModules, 'icewarp', () =>
        this.listIcewarp(tenantSlug),
      ),
      this.optionalInventory(tenantModules, 'sap', () => this.listSap(tenantSlug)),
    ]);
    const inSite = <T extends { siteId: string | null }>(items: T[]) =>
      items.filter((item) => !siteSlug || item.siteId === siteSlug);
    const nics = inSite(allNics);
    const databases = tenantHasModule(tenantModules, 'databases')
      ? inSite(allDatabases)
      : [];
    const networkDevices = tenantHasModule(tenantModules, 'network')
      ? inSite(allNetworkDevices)
      : [];
    const queues = tenantHasModule(tenantModules, 'queues')
      ? inSite(allQueues)
      : [];
    const icewarp = tenantHasModule(tenantModules, 'icewarp')
      ? inSite(allIcewarp)
      : [];
    const sap = tenantHasModule(tenantModules, 'sap') ? inSite(allSap) : [];
    const requested = this.sanitize(agentIdInput);
    const wantIcewarp =
      this.sanitize(viewInput) === 'icewarp' &&
      tenantHasModule(tenantModules, 'icewarp');
    const hostId = wantIcewarp
      ? requested || icewarp[0]?.hostId || hosts[0]?.id || null
      : (requested && hosts.some((item) => item.id === requested)
          ? requested
          : null) ||
        hosts[0]?.id ||
        null;
    if (!hostId) {
      return {
        hosts,
        nics,
        databases,
        networkDevices,
        queues,
        icewarp,
        sap,
        icewarpBoard: wantIcewarp ? this.emptyIcewarp(null) : undefined,
        agents: hosts.map((item) => ({
          agentId: item.id,
          siteId: item.siteId,
          tenantId: item.tenantId,
        })),
        agentId: null,
        host: this.emptyHost(),
        agent: this.emptyAgent(),
        logs: { volume: [], volumeAll: [], lines: [] },
        thresholds: await this.platform.thresholds('agents', tenantSlug || 'default'),
        refreshedAt: Date.now(),
      };
    }

    const selected = hosts.find((item) => item.id === hostId);
    const sel = (extra = '') =>
      extra ? `{agent_id="${hostId}",${extra}}` : `{agent_id="${hostId}"}`;
    const rate = window.rate;
    const cpuQuery = `1 - sum(rate(system_cpu_time_seconds_total${sel('state="idle"')}[${rate}])) / sum(rate(system_cpu_time_seconds_total${sel()}[${rate}]))`;
    const cpuStateQuery = `sum by (state) (rate(system_cpu_time_seconds_total${sel('state!="idle"')}[${rate}])) / ignoring(state) group_left sum(rate(system_cpu_time_seconds_total${sel()}[${rate}]))`;
    const memQuery = `sum(system_memory_usage_bytes${sel('state="used"')}) / sum(system_memory_usage_bytes${sel()})`;
    const memStateQuery = `sum by (state) (system_memory_usage_bytes${sel('state!="free"')})`;
    const diskQuery = `sum(system_filesystem_usage_bytes${sel('mountpoint="/",state="used"')}) / sum(system_filesystem_usage_bytes${sel('mountpoint="/"')})`;
    const fs = 'type!="squashfs",mountpoint!~"/snap.*"';
    const diskUsedQuery = `sum by (mountpoint, device, type) (system_filesystem_usage_bytes${sel(`state="used",${fs}`)})`;
    const diskFreeQuery = `sum by (mountpoint, device, type) (system_filesystem_usage_bytes${sel(`state="free",${fs}`)})`;
    const diskTotalQuery = `sum by (mountpoint, device, type) (system_filesystem_usage_bytes${sel(fs)})`;
    const netQuery = `sum by (direction) (rate(system_network_io_bytes_total${sel('device!="lo"')}[${rate}]))`;
    const diskIoQuery = `sum by (direction) (rate(system_disk_io_bytes_total${sel('device!~"loop.*"')}[${rate}]))`;
    const diskOpsQuery = `sum by (direction) (rate(system_disk_operations_total${sel('device!~"loop.*"')}[${rate}]))`;
    const netPktQuery = `sum by (direction) (rate(system_network_packets_total${sel('device!="lo"')}[${rate}]))`;
    const netErrQuery = `sum(rate(system_network_errors_total${sel('device!="lo"')}[${rate}]))`;
    const netDropQuery = `sum(rate(system_network_dropped_total${sel('device!="lo"')}[${rate}]))`;
    const netConnQuery = `sum by (protocol, state) (system_network_connections${sel()})`;

    const [
      cpus,
      cpu,
      mem,
      memUsedBytes,
      memTotalBytes,
      disk,
      diskUsedBytes,
      diskTotalBytes,
      diskUsedRows,
      diskFreeRows,
      diskTotalRows,
      load1,
      load5,
      load15,
      uptime,
      uptimeAlt,
      cpuSeries,
      cpuStateSeries,
      load1Series,
      load5Series,
      load15Series,
      memStateSeries,
      netSeries,
      diskIoSeries,
      diskOpsSeries,
      netPktSeries,
      netErrSeries,
      netDropSeries,
      netConnSeries,
      online,
      lastSample,
      agentUptime,
      license,
      licenseLeft,
      info,
      identity,
      modules,
      known,
      suggested,
      volume,
      volumeAll,
      lines,
      processes,
    ] = await Promise.all([
      this.safeInstant(`system_cpu_logical_count${sel()}`),
      this.safeInstant(cpuQuery),
      this.safeInstant(memQuery),
      this.safeInstant(`sum(system_memory_usage_bytes${sel('state="used"')})`),
      this.safeInstant(`sum(system_memory_usage_bytes${sel()})`),
      this.safeInstant(diskQuery),
      this.safeInstant(
        `sum(system_filesystem_usage_bytes${sel('mountpoint="/",state="used"')})`,
      ),
      this.safeInstant(
        `sum(system_filesystem_usage_bytes${sel('mountpoint="/"')})`,
      ),
      this.safeInstant(diskUsedQuery),
      this.safeInstant(diskFreeQuery),
      this.safeInstant(diskTotalQuery),
      this.safeInstant(`max(system_cpu_load_average_1m${sel()})`),
      this.safeInstant(`max(system_cpu_load_average_5m${sel()})`),
      this.safeInstant(`max(system_cpu_load_average_15m${sel()})`),
      this.safeInstant(`max(system_uptime${sel()})`),
      this.safeInstant(`max(system_uptime_seconds${sel()})`),
      this.safeRange(cpuQuery, window),
      this.safeRange(cpuStateQuery, window),
      this.safeRange(`max(system_cpu_load_average_1m${sel()})`, window),
      this.safeRange(`max(system_cpu_load_average_5m${sel()})`, window),
      this.safeRange(`max(system_cpu_load_average_15m${sel()})`, window),
      this.safeRange(memStateQuery, window),
      this.safeRange(netQuery, window),
      this.safeRange(diskIoQuery, window),
      this.safeRange(diskOpsQuery, window),
      this.safeRange(netPktQuery, window),
      this.safeRange(netErrQuery, window),
      this.safeRange(netDropQuery, window),
      this.safeRange(netConnQuery, window),
      this.safeInstant(
        `max(present_over_time(ekms_agent_identity${sel()}[2m])) or vector(0)`,
      ),
      this.safeInstant(`time() - max(timestamp(ekms_agent_identity${sel()}))`),
      this.safeInstant(`time() - max(process_start_time_seconds${sel()})`),
      this.safeInstant('max(ekms_agent_license_valid) or vector(0)'),
      this.safeInstant(
        'max(ekms_agent_license_until_timestamp_seconds) - time()',
      ),
      this.safeInstant('ekms_agent_info'),
      this.safeInstant(`ekms_agent_identity${sel()}`),
      this.safeInstant(`ekms_agent_module_enabled${sel()}`),
      this.safeInstant('sum(ekms_asset_known) or vector(0)'),
      this.safeInstant('sum(ekms_asset_suggested) or vector(0)'),
      this.safeLokiRange(
        'sum(count_over_time({service_name="ekumetrics-agent"}[5m]))',
        window,
      ),
      this.safeLokiRange(
        'sum(count_over_time({service_name=~".+"}[5m]))',
        window,
      ),
      this.safeLokiLines('{service_name="ekumetrics-agent"}', window.seconds),
      this.listProcesses(hostId),
    ]);

    const ident = identity[0]?.metric ?? {};
    const receive =
      netSeries.find((row) => row.metric.direction === 'receive')?.values ?? [];
    const transmit =
      netSeries.find((row) => row.metric.direction === 'transmit')?.values ??
      [];
    const icewarpBoard = wantIcewarp
      ? await this.loadIcewarpBoard(hostId, window, icewarp)
      : undefined;

    return {
      hosts,
      nics,
      databases,
      networkDevices,
      queues,
      icewarp,
      sap,
      icewarpBoard,
      agents: hosts.map((item) => ({
        agentId: item.id,
        siteId: item.siteId,
        tenantId: item.tenantId,
      })),
      agentId: hostId,
      thresholds: await this.platform.thresholds('agents', tenantSlug || 'default'),
      refreshedAt: Date.now(),
      host: {
        id: hostId,
        siteId: selected?.siteId ?? ident.site_id ?? null,
        tenantId: selected?.tenantId ?? ident.tenant_id ?? null,
        cpus: this.telemetry.first(cpus),
        cpuUsed: this.telemetry.first(cpu),
        memoryUsed: this.telemetry.first(mem),
        memoryUsedBytes: this.telemetry.first(memUsedBytes),
        memoryTotalBytes: this.telemetry.first(memTotalBytes),
        diskUsed: this.telemetry.first(disk),
        diskUsedBytes: this.telemetry.first(diskUsedBytes),
        diskTotalBytes: this.telemetry.first(diskTotalBytes),
        disks: this.mergeDisks(diskUsedRows, diskFreeRows, diskTotalRows),
        processes,
        load1m: this.telemetry.first(load1),
        load5m: this.telemetry.first(load5),
        load15m: this.telemetry.first(load15),
        uptimeSeconds:
          this.telemetry.first(uptime) ?? this.telemetry.first(uptimeAlt),
        series: {
          cpu: cpuSeries[0]?.values ?? [],
          cpuByState: cpuStateSeries.map((row) => ({
            state: row.metric.state || 'cpu',
            values: row.values,
          })),
          load1: load1Series[0]?.values ?? [],
          load5: load5Series[0]?.values ?? [],
          load15: load15Series[0]?.values ?? [],
          memoryByState: memStateSeries.map((row) => ({
            state: row.metric.state || 'memory',
            values: row.values,
          })),
          networkRx: receive,
          networkTx: transmit,
          diskIo: this.named(
            diskIoSeries,
            (metric) => metric.direction || 'io',
          ),
          diskOps: this.named(
            diskOpsSeries,
            (metric) => metric.direction || 'ops',
          ),
          networkPackets: this.named(
            netPktSeries,
            (metric) => metric.direction || 'packets',
          ),
          networkFaults: [
            ...this.named(netErrSeries, () => 'errores'),
            ...this.named(netDropSeries, () => 'descartes'),
          ],
          networkConn: this.named(netConnSeries, (metric) =>
            `${metric.protocol || 'net'} ${metric.state || ''}`.trim(),
          ),
        },
      },
      agent: {
        online: (this.telemetry.first(online) ?? 0) >= 1,
        lastSampleSeconds: this.telemetry.first(lastSample),
        uptimeSeconds: this.telemetry.first(agentUptime),
        licenseValid: this.bool(this.telemetry.first(license)),
        licenseRemainingSeconds: this.telemetry.first(licenseLeft),
        version: info[0]?.metric.version ?? null,
        identity: this.identity(ident),
        modules: modules.map((row) => ({
          module: row.metric.module ?? 'unknown',
          enabled: row.value >= 1,
        })),
        assetsKnown: this.telemetry.first(known),
        assetsSuggested: this.telemetry.first(suggested),
      },
      logs: {
        volume,
        volumeAll,
        lines,
      },
    };
  }

  private async listHosts(tenantSlug = ''): Promise<DashboardHost[]> {
    const unique = new Map<string, DashboardHost>();
    const add = (item: DashboardHost) => {
      if (!item.id || unique.has(item.id)) {
        return;
      }
      unique.set(item.id, item);
    };
    if (tenantSlug) {
      try {
        const tenant = await this.tenants.requireTenant(tenantSlug);
        const registered = await this.prisma.agent.findMany({
          where: { tenantId: tenant.id },
        });
        for (const agent of registered) {
          add({
            id: agent.agentId,
            siteId: agent.siteId,
            tenantId: tenant.slug,
            mode: agent.mode || null,
            version: null,
            online: null,
            cpuUsed: null,
            memoryUsed: null,
            uptimeSeconds: null,
            agentUptimeSeconds: null,
            cpus: null,
          });
        }
      } catch {
        return [];
      }
    }
    const selector = this.tenantSelector(tenantSlug);
    for (const row of await this.safeInstant(
      `system_cpu_logical_count${selector}`,
    )) {
      add({
        id: row.metric.agent_id?.trim() ?? '',
        siteId:
          row.metric.site_id ?? row.metric.host_site ?? row.metric.site ?? null,
        tenantId: row.metric.tenant_id ?? tenantSlug ?? null,
        mode: row.metric.mode ?? null,
        version: null,
        online: null,
        cpuUsed: null,
        memoryUsed: null,
        uptimeSeconds: null,
        agentUptimeSeconds: null,
        cpus: null,
      });
    }
    if (unique.size === 0) {
      for (const row of await this.safeInstant(
        `ekms_agent_identity${selector}`,
      )) {
        add({
          id: row.metric.agent_id?.trim() ?? '',
          siteId: row.metric.site_id ?? row.metric.site ?? null,
          tenantId: row.metric.tenant_id ?? tenantSlug ?? null,
          mode: row.metric.mode ?? null,
          version: row.metric.version ?? null,
          online: null,
          cpuUsed: null,
          memoryUsed: null,
          uptimeSeconds: null,
          agentUptimeSeconds: null,
          cpus: null,
        });
      }
    }
    return [...unique.values()];
  }

  private tenantSelector(tenantSlug: string, extra = '') {
    const parts = [tenantSlug ? `tenant_id="${tenantSlug}"` : '', extra].filter(
      Boolean,
    );
    return parts.length ? `{${parts.join(',')}}` : '';
  }

  private async enrichHosts(hosts: DashboardHost[]): Promise<DashboardHost[]> {
    if (hosts.length === 0) {
      return hosts;
    }
    const [
      cpuRows,
      memRows,
      uptimeRows,
      agentUptimeRows,
      coreRows,
      identRows,
      infoRows,
      onlineRows,
    ] = await Promise.all([
      this.safeInstant(
        '1 - sum by (agent_id) (rate(system_cpu_time_seconds_total{state="idle"}[1m])) / sum by (agent_id) (rate(system_cpu_time_seconds_total[1m]))',
      ),
      this.safeInstant(
        'sum by (agent_id) (system_memory_usage_bytes{state="used"}) / sum by (agent_id) (system_memory_usage_bytes)',
      ),
      this.safeInstant(
        'max by (agent_id) (system_uptime_seconds) or max by (agent_id) (system_uptime)',
      ),
      this.safeInstant(
        'time() - max by (agent_id) (process_start_time_seconds)',
      ),
      this.safeInstant('max by (agent_id) (system_cpu_logical_count)'),
      this.safeInstant('ekms_agent_identity'),
      this.safeInstant('ekms_agent_info'),
      this.safeInstant(
        'max by (agent_id) (present_over_time(ekms_agent_identity[2m]))',
      ),
    ]);
    const cpu = this.valueByAgent(cpuRows);
    const mem = this.valueByAgent(memRows);
    const uptime = this.valueByAgent(uptimeRows);
    const agentUptime = this.valueByAgent(agentUptimeRows);
    const cores = this.valueByAgent(coreRows);
    const modes = this.labelByAgent(identRows, 'mode');
    const versions = this.labelByAgent(infoRows, 'version');
    const versionsBySite = this.labelByKey(infoRows, 'site', 'version');
    const online = this.valueByAgent(onlineRows);
    return hosts.map((host) => ({
      ...host,
      mode: modes.get(host.id) ?? host.mode,
      version:
        versions.get(host.id) ??
        (host.siteId ? versionsBySite.get(host.siteId) : undefined) ??
        host.version,
      online: online.has(host.id) ? online.get(host.id)! >= 1 : host.online,
      cpuUsed: cpu.get(host.id) ?? null,
      memoryUsed: mem.get(host.id) ?? null,
      uptimeSeconds: uptime.get(host.id) ?? null,
      agentUptimeSeconds: agentUptime.get(host.id) ?? null,
      cpus: cores.get(host.id) ?? null,
    }));
  }

  private async listProcesses(hostId: string) {
    const sel = `{agent_id="${hostId}"}`;
    const [cpuRows, memRows, virtRows, diskRows] = await Promise.all([
      this.safeInstant(
        `sum by (process, pid) (rate(process_cpu_time_seconds_total${sel}[1m]))`,
      ),
      this.safeInstant(
        `sum by (process, pid) (process_memory_usage_bytes${sel})`,
      ),
      this.safeInstant(
        `sum by (process, pid) (process_memory_virtual_bytes${sel})`,
      ),
      this.safeInstant(
        `sum by (process, pid, direction) (rate(process_disk_io_bytes_total${sel}[1m]))`,
      ),
    ]);
    const items = new Map<
      string,
      {
        name: string;
        pid: string;
        cpu: number | null;
        memoryBytes: number | null;
        virtualBytes: number | null;
        diskReadBytesPerSec: number;
        diskWriteBytesPerSec: number;
      }
    >();
    const upsert = (metric: Record<string, string>) => {
      const name = (metric.process || metric.command || '').trim();
      const pid = String(metric.pid ?? '').trim();
      const key = `${name}|${pid}`;
      const current = items.get(key) ?? {
        name: name || (pid ? `pid ${pid}` : ''),
        pid,
        cpu: null,
        memoryBytes: null,
        virtualBytes: null,
        diskReadBytesPerSec: 0,
        diskWriteBytesPerSec: 0,
      };
      items.set(key, current);
      return current;
    };
    for (const row of cpuRows) {
      if (!Number.isFinite(row.value)) {
        continue;
      }
      upsert(row.metric).cpu = row.value;
    }
    for (const row of memRows) {
      if (!Number.isFinite(row.value)) {
        continue;
      }
      upsert(row.metric).memoryBytes = row.value;
    }
    for (const row of virtRows) {
      if (!Number.isFinite(row.value)) {
        continue;
      }
      upsert(row.metric).virtualBytes = row.value;
    }
    for (const row of diskRows) {
      if (!Number.isFinite(row.value)) {
        continue;
      }
      const item = upsert(row.metric);
      if (row.metric.direction === 'write') {
        item.diskWriteBytesPerSec = row.value;
      } else {
        item.diskReadBytesPerSec = row.value;
      }
    }
    return [...items.values()]
      .filter((item) => item.name || item.pid)
      .sort(
        (a, b) =>
          (b.cpu ?? 0) - (a.cpu ?? 0) ||
          (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0),
      )
      .slice(0, 40);
  }

  private async listNics(tenantSlug = ''): Promise<DashboardNic[]> {
    const tenant = tenantSlug ? `tenant_id="${tenantSlug}",` : '';
    const [ioRows, errorRows, dropRows] = await Promise.all([
      this.safeInstant(
        `sum by (agent_id, site_id, device, direction) (rate(system_network_io_bytes_total{${tenant}device!="lo"}[1m]))`,
      ),
      this.safeInstant(
        `sum by (agent_id, device) (rate(system_network_errors_total{${tenant}device!="lo"}[1m]))`,
      ),
      this.safeInstant(
        `sum by (agent_id, device) (rate(system_network_dropped_total{${tenant}device!="lo"}[1m]))`,
      ),
    ]);
    const items = new Map<string, DashboardNic>();
    const keyOf = (hostId: string, device: string) => `${hostId}|${device}`;
    const upsert = (hostId: string, device: string, siteId: string | null) => {
      const key = keyOf(hostId, device);
      const current = items.get(key) ?? {
        hostId,
        siteId,
        device,
        rxBytesPerSec: 0,
        txBytesPerSec: 0,
        errorsPerSec: 0,
        dropsPerSec: 0,
      };
      items.set(key, current);
      return current;
    };
    for (const row of ioRows) {
      const hostId = row.metric.agent_id?.trim();
      const device = row.metric.device?.trim();
      if (!hostId || !device || !Number.isFinite(row.value)) {
        continue;
      }
      const item = upsert(hostId, device, row.metric.site_id ?? null);
      if (row.metric.direction === 'receive') {
        item.rxBytesPerSec = row.value;
      }
      if (row.metric.direction === 'transmit') {
        item.txBytesPerSec = row.value;
      }
    }
    for (const row of errorRows) {
      const hostId = row.metric.agent_id?.trim();
      const device = row.metric.device?.trim();
      if (!hostId || !device || !Number.isFinite(row.value)) {
        continue;
      }
      upsert(hostId, device, null).errorsPerSec = row.value;
    }
    for (const row of dropRows) {
      const hostId = row.metric.agent_id?.trim();
      const device = row.metric.device?.trim();
      if (!hostId || !device || !Number.isFinite(row.value)) {
        continue;
      }
      upsert(hostId, device, null).dropsPerSec = row.value;
    }
    return [...items.values()].sort((a, b) => a.device.localeCompare(b.device));
  }

  private async listDatabases(tenantSlug = ''): Promise<DashboardDatabase[]> {
    const sel = this.tenantSelector(tenantSlug);
    return this.collectTargets(tenantSlug, [
      {
        engine: 'postgresql',
        query: `count by (agent_id, site_id, database_name) (postgresql_backends${sel})`,
      },
      {
        engine: 'postgresql',
        query: `count by (agent_id, site_id, database_name) (postgresql_database_count${sel})`,
      },
      {
        engine: 'mysql',
        query: `count by (agent_id, site_id) (mysql_buffer_pool_data_pages${sel})`,
      },
      {
        engine: 'mysql',
        query: `count by (agent_id, site_id) (mysql_uptime${sel})`,
      },
      {
        engine: 'mongodb',
        query: `count by (agent_id, site_id) (mongodb_connection_count${sel})`,
      },
      {
        engine: 'mongodb',
        query: `count by (agent_id, site_id) (mongodb_connections${sel})`,
      },
      {
        engine: 'redis',
        query: `count by (agent_id, site_id) (redis_uptime${sel})`,
      },
      {
        engine: 'redis',
        query: `count by (agent_id, site_id) (redis_clients${sel})`,
      },
      { engine: 'datastore', query: `ekms_datastore_up${sel}` },
    ]);
  }

  private async listNetworkDevices(
    tenantSlug = '',
  ): Promise<DashboardTarget[]> {
    const sel = this.tenantSelector(tenantSlug);
    return this.collectTargets(tenantSlug, [
      {
        engine: 'snmp',
        query: `count by (agent_id, site_id, service_instance_id, net_peer_name, net_host_name, net_peer_ip) (snmp_sys_uptime${sel})`,
      },
    ]);
  }

  private async listQueues(tenantSlug = ''): Promise<DashboardTarget[]> {
    const sel = this.tenantSelector(tenantSlug);
    return this.collectTargets(tenantSlug, [
      {
        engine: 'kafka',
        query: `count by (agent_id, site_id) (kafka_brokers${sel})`,
      },
      {
        engine: 'rabbitmq',
        query: `count by (agent_id, site_id) (rabbitmq_consumer_count${sel})`,
      },
      {
        engine: 'rabbitmq',
        query: `count by (agent_id, site_id) (rabbitmq_message_current${sel})`,
      },
      {
        engine: 'nats',
        query: `count by (agent_id, site_id) (nats_varz_connections${sel})`,
      },
    ]);
  }

  private async listSap(tenantSlug = ''): Promise<DashboardTarget[]> {
    const sel = this.tenantSelector(tenantSlug);
    return this.collectTargets(tenantSlug, [
      {
        engine: 'sap',
        query: `count by (agent_id, site_id, sap_system) (ekms_sap_sessions_total${sel})`,
      },
      {
        engine: 'sap',
        query: `count by (agent_id, site_id) (ekms_agent_module_enabled${this.tenantSelector(tenantSlug, 'module="sap"')} == 1)`,
      },
    ]);
  }

  private emptyIcewarp(hostId: string | null): DashboardIcewarp {
    return {
      hostId,
      name: '',
      servicesUp: 0,
      servicesTotal: 0,
      sessions: null,
      smtpIn: null,
      smtpOut: null,
      smtpFailed: null,
      rejected: null,
      services: [],
      probes: [],
      series: {
        sessions: [],
        memory: [],
        smtp: [],
        defense: [],
        probesRtt: [],
      },
    };
  }

  // IceWarp publica svcUpTime como TimeTicks (centesimas de segundo).
  private icewarpUptimeSeconds(raw: number | null | undefined): number | null {
    if (raw == null || !Number.isFinite(raw)) {
      return null;
    }
    return raw / 100;
  }

  // IceWarp 14.x publica VSZ en INTEGER con signo. Si pasa de 2 GiB, llega negativo.
  private icewarpWorkingSetBytes(
    raw: number | null | undefined,
    running = true,
  ): number | null {
    if (!running || raw == null || !Number.isFinite(raw)) {
      return null;
    }
    return raw < 0 ? raw + 4_294_967_296 : raw;
  }

  private icewarpSvcName(metric: Record<string, string>): string {
    return (
      metric.icewarp_svc?.trim() ||
      metric.service_instance_id?.trim() ||
      metric.name?.trim() ||
      'servicio'
    );
  }

  private valueBySvc(rows: InstantRow[]): Map<string, number> {
    const values = new Map<string, number>();
    for (const row of rows) {
      if (!Number.isFinite(row.value)) {
        continue;
      }
      values.set(this.icewarpSvcName(row.metric), row.value);
    }
    return values;
  }

  private smtpDelta(metric: string, sel: string, range: string): string {
    return `clamp_min(sum(delta(${metric}${sel}[${range}])), 0)`;
  }

  private async loadIcewarpBoard(
    hostId: string,
    window: { seconds: number; step: number; rate: string },
    inventory: DashboardTarget[],
  ): Promise<DashboardIcewarp> {
    const sel = `{agent_id="${hostId}"}`;
    const probeSel = `{agent_id="${hostId}",name=~".+-(25|587|143|993|443)"}`;
    const range = `${window.seconds}s`;
    const rate = window.rate;
    const [
      running,
      uptime,
      sessions,
      peak,
      mem,
      smtpIn,
      smtpOut,
      smtpFailed,
      virus,
      cf,
      dnsbl,
      tarpit,
      spam,
      sessionsSeries,
      memSeries,
      smtpInSeries,
      smtpOutSeries,
      smtpFailedSeries,
      virusSeries,
      spamSeries,
      dnsblSeries,
      cfSeries,
      tarpitSeries,
      probesUp,
      probesRtt,
      probesRttSeries,
    ] = await Promise.all([
      this.safeInstant(`icewarp_svc_running${sel}`),
      this.safeInstant(`icewarp_svc_uptime${sel}`),
      this.safeInstant(`icewarp_svc_sessions${sel}`),
      this.safeInstant(`icewarp_svc_sessions_peak${sel}`),
      this.safeInstant(`icewarp_svc_working_set${sel}`),
      this.safeInstant(this.smtpDelta('icewarp_smtp_in', sel, range)),
      this.safeInstant(this.smtpDelta('icewarp_smtp_out', sel, range)),
      this.safeInstant(this.smtpDelta('icewarp_smtp_failed', sel, range)),
      this.safeInstant(this.smtpDelta('icewarp_smtp_virus', sel, range)),
      this.safeInstant(this.smtpDelta('icewarp_smtp_cf', sel, range)),
      this.safeInstant(this.smtpDelta('icewarp_smtp_dnsbl', sel, range)),
      this.safeInstant(this.smtpDelta('icewarp_smtp_tarpit', sel, range)),
      this.safeInstant(this.smtpDelta('icewarp_smtp_spam', sel, range)),
      this.safeRange(`icewarp_svc_sessions${sel}`, window),
      this.safeRange(`icewarp_svc_working_set${sel}`, window),
      this.safeRange(this.smtpDelta('icewarp_smtp_in', sel, rate), window),
      this.safeRange(this.smtpDelta('icewarp_smtp_out', sel, rate), window),
      this.safeRange(this.smtpDelta('icewarp_smtp_failed', sel, rate), window),
      this.safeRange(this.smtpDelta('icewarp_smtp_virus', sel, rate), window),
      this.safeRange(this.smtpDelta('icewarp_smtp_spam', sel, rate), window),
      this.safeRange(this.smtpDelta('icewarp_smtp_dnsbl', sel, rate), window),
      this.safeRange(this.smtpDelta('icewarp_smtp_cf', sel, rate), window),
      this.safeRange(this.smtpDelta('icewarp_smtp_tarpit', sel, rate), window),
      this.safeInstant(`ekms_probe_up${probeSel}`),
      this.safeInstant(`ekms_probe_rtt_seconds${probeSel}`),
      this.safeRange(`ekms_probe_rtt_seconds${probeSel}`, window),
    ]);
    const runMap = this.valueBySvc(running);
    const upMap = this.valueBySvc(uptime);
    const sessMap = this.valueBySvc(sessions);
    const peakMap = this.valueBySvc(peak);
    const memMap = this.valueBySvc(mem);
    const names = new Set<string>([
      ...runMap.keys(),
      ...sessMap.keys(),
      ...memMap.keys(),
    ]);
    const services = [...names]
      .sort((left, right) => left.localeCompare(right))
      .map((name) => {
        const running = (runMap.get(name) ?? 0) >= 1;
        return {
          name,
          running,
          uptimeSeconds: this.icewarpUptimeSeconds(upMap.get(name)),
          sessions: sessMap.get(name) ?? null,
          sessionsPeak: peakMap.get(name) ?? null,
          workingSetBytes: this.icewarpWorkingSetBytes(
            memMap.get(name),
            running,
          ),
        };
      });
    const rttMap = new Map(
      probesRtt
        .filter((row) => Number.isFinite(row.value))
        .map((row) => [
          row.metric.name || row.metric.endpoint || 'probe',
          row.value,
        ]),
    );
    const probes = probesUp.map((row) => {
      const name = row.metric.name || row.metric.endpoint || 'probe';
      return {
        name,
        endpoint: row.metric.endpoint || '',
        up: Number.isFinite(row.value) && row.value >= 1,
        rttSeconds: rttMap.get(name) ?? null,
      };
    });
    const first = (rows: InstantRow[]) => this.telemetry.first(rows);
    const smtpInValue = first(smtpIn);
    const smtpOutValue = first(smtpOut);
    const smtpFailedValue = first(smtpFailed);
    const rejectedParts = [smtpFailed, virus, cf, dnsbl, tarpit, spam].map(
      (rows) => first(rows),
    );
    const rejected = rejectedParts.every((value) => value === null)
      ? null
      : rejectedParts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const named = (
      rows: Array<{
        metric: Record<string, string>;
        values: Array<[number, number]>;
      }>,
      label: (metric: Record<string, string>) => string,
    ) => this.named(rows, label);
    const inventoryName =
      inventory.find((item) => item.hostId === hostId)?.name || hostId;
    return {
      hostId,
      name: inventoryName,
      servicesUp: services.filter((item) => item.running).length,
      servicesTotal: services.length,
      sessions:
        sessMap.size === 0
          ? null
          : [...sessMap.values()].reduce((sum, value) => sum + value, 0),
      smtpIn: smtpInValue,
      smtpOut: smtpOutValue,
      smtpFailed: smtpFailedValue,
      rejected,
      services,
      probes,
      series: {
        sessions: named(sessionsSeries, (metric) =>
          this.icewarpSvcName(metric),
        ),
        memory: named(
          memSeries
            .filter(
              (row) => (runMap.get(this.icewarpSvcName(row.metric)) ?? 0) >= 1,
            )
            .map((row) => ({
              metric: row.metric,
              values: row.values
                .map(([time, value]) => {
                  const bytes = this.icewarpWorkingSetBytes(value, true);
                  return bytes == null
                    ? null
                    : ([time, bytes] as [number, number]);
                })
                .filter((point): point is [number, number] => point != null),
            })),
          (metric) => this.icewarpSvcName(metric),
        ),
        smtp: [
          ...named(smtpInSeries, () => 'recibidos'),
          ...named(smtpOutSeries, () => 'enviados'),
          ...named(smtpFailedSeries, () => 'fallidos'),
        ],
        defense: [
          ...named(virusSeries, () => 'virus'),
          ...named(spamSeries, () => 'spam'),
          ...named(dnsblSeries, () => 'DNSBL'),
          ...named(cfSeries, () => 'content filter'),
          ...named(tarpitSeries, () => 'tarpit'),
        ],
        probesRtt: named(
          probesRttSeries,
          (metric) => metric.name || metric.endpoint || 'probe',
        ),
      },
    };
  }

  private async listIcewarp(tenantSlug = ''): Promise<DashboardTarget[]> {
    const sel = this.tenantSelector(tenantSlug);
    return this.collectTargets(tenantSlug, [
      {
        engine: 'icewarp',
        query: `count by (agent_id, site_id, service_instance_id) (icewarp_svc_running${sel})`,
      },
    ]);
  }

  private async collectTargets(
    _tenantSlug: string,
    probes: Array<{ engine: string; query: string }>,
  ): Promise<DashboardTarget[]> {
    const items: DashboardTarget[] = [];
    const seen = new Set<string>();
    for (const probe of probes) {
      for (const row of await this.safeInstant(probe.query)) {
        const hostId = row.metric.agent_id?.trim();
        if (!hostId) {
          continue;
        }
        const name =
          row.metric.database_name ||
          row.metric.name ||
          row.metric.net_peer_name ||
          row.metric.net_host_name ||
          row.metric.net_peer_ip ||
          row.metric.service_instance_id ||
          row.metric.if_name ||
          row.metric.icewarp_svc ||
          row.metric.sap_system ||
          probe.engine;
        const engine = row.metric.type || probe.engine;
        const key = `${hostId}|${engine}|${name}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        items.push({
          hostId,
          siteId: row.metric.site_id ?? null,
          engine,
          name,
          up: Number.isFinite(row.value) && row.value > 0,
        });
      }
    }
    return items;
  }

  private labelByAgent(rows: InstantRow[], key: string): Map<string, string> {
    return this.labelByKey(rows, 'agent_id', key);
  }

  private labelByKey(
    rows: InstantRow[],
    idKey: string,
    valueKey: string,
  ): Map<string, string> {
    const values = new Map<string, string>();
    for (const row of rows) {
      const id = row.metric[idKey]?.trim();
      const label = row.metric[valueKey]?.trim();
      if (!id || !label) {
        continue;
      }
      values.set(id, label);
    }
    return values;
  }

  private valueByAgent(rows: InstantRow[]): Map<string, number> {
    const values = new Map<string, number>();
    for (const row of rows) {
      const id = row.metric.agent_id?.trim();
      if (!id || !Number.isFinite(row.value)) {
        continue;
      }
      values.set(id, row.value);
    }
    return values;
  }

  private sanitize(value?: string): string {
    return (value ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '');
  }

  private bool(value: number | null): boolean | null {
    if (value === null) {
      return null;
    }
    return value >= 1;
  }

  private identity(metric: Record<string, string>): Record<string, string> {
    const skip = new Set([
      '__name__',
      'instance',
      'job',
      'exported_instance',
      'exported_job',
      'otel_scope_name',
      'otel_scope_version',
    ]);
    return Object.fromEntries(
      Object.entries(metric).filter(([key]) => !skip.has(key)),
    );
  }

  private emptyHost() {
    return {
      id: null,
      siteId: null,
      tenantId: null,
      cpus: null,
      cpuUsed: null,
      memoryUsed: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      diskUsed: null,
      diskUsedBytes: null,
      diskTotalBytes: null,
      disks: [],
      processes: [],
      load1m: null,
      load5m: null,
      load15m: null,
      uptimeSeconds: null,
      series: {
        cpu: [],
        cpuByState: [],
        load1: [],
        load5: [],
        load15: [],
        memoryByState: [],
        networkRx: [],
        networkTx: [],
        diskIo: [],
        diskOps: [],
        networkPackets: [],
        networkFaults: [],
        networkConn: [],
      },
    };
  }

  private mergeDisks(
    usedRows: InstantRow[],
    freeRows: InstantRow[],
    totalRows: InstantRow[],
  ) {
    const keyOf = (metric: Record<string, string>) =>
      `${metric.mountpoint || '/'}|${metric.device || ''}|${metric.type || ''}`;
    const usedMap = new Map(usedRows.map((row) => [keyOf(row.metric), row]));
    const freeMap = new Map(freeRows.map((row) => [keyOf(row.metric), row]));
    const keys = new Set([
      ...usedRows.map((row) => keyOf(row.metric)),
      ...totalRows.map((row) => keyOf(row.metric)),
    ]);
    return [...keys]
      .map((key) => {
        const usedRow = usedMap.get(key);
        const freeRow = freeMap.get(key);
        const totalRow = totalRows.find((row) => keyOf(row.metric) === key);
        const metric = usedRow?.metric ?? totalRow?.metric ?? {};
        const usedBytes = this.telemetry.first(usedRow ? [usedRow] : []) ?? 0;
        const freeBytes = this.telemetry.first(freeRow ? [freeRow] : []) ?? 0;
        const totalBytes =
          this.telemetry.first(totalRow ? [totalRow] : []) ??
          usedBytes + freeBytes;
        return {
          mount: metric.mountpoint || '/',
          device: metric.device || '',
          type: metric.type || '',
          usedBytes,
          freeBytes,
          totalBytes,
          used: totalBytes > 0 ? usedBytes / totalBytes : 0,
        };
      })
      .sort((a, b) => b.used - a.used);
  }

  private named(
    rows: Array<{
      metric: Record<string, string>;
      values: Array<[number, number]>;
    }>,
    label: (metric: Record<string, string>) => string,
  ) {
    return rows.map((row) => ({
      state: label(row.metric),
      values: row.values,
    }));
  }

  private emptyAgent() {
    return {
      online: false,
      lastSampleSeconds: null,
      uptimeSeconds: null,
      licenseValid: null,
      licenseRemainingSeconds: null,
      version: null,
      identity: {},
      modules: [],
      assetsKnown: null,
      assetsSuggested: null,
    };
  }

  private async safeInstant(query: string): Promise<InstantRow[]> {
    try {
      return await this.telemetry.instant(query);
    } catch {
      return [];
    }
  }

  private windowFor(rangeInput?: string): {
    seconds: number;
    step: number;
    rate: string;
  } {
    const catalog: Record<string, number> = {
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '1h': 3600,
      '3h': 10800,
      '6h': 21600,
      '12h': 43200,
      '24h': 86400,
      '7d': 604800,
    };
    const raw = (rangeInput ?? '').trim();
    const seconds = Math.min(
      604800,
      Math.max(60, catalog[raw] ?? (Number(raw) || 900)),
    );
    let step = 10;
    if (seconds <= 120) {
      step = 5;
    } else if (seconds > 86400) {
      step = 900;
    } else if (seconds > 43200) {
      step = 180;
    } else if (seconds > 21600) {
      step = 120;
    } else if (seconds > 10800) {
      step = 60;
    } else if (seconds > 3600) {
      step = 30;
    } else if (seconds > 900) {
      step = 20;
    }
    return { seconds, step, rate: seconds <= 3600 ? '1m' : '5m' };
  }

  private async safeRange(
    query: string,
    window: { seconds: number; step: number },
  ) {
    try {
      return await this.telemetry.range(query, window.seconds, window.step);
    } catch {
      return [];
    }
  }

  private async safeLokiRange(
    query: string,
    window: { seconds: number; step: number },
  ) {
    try {
      return await this.telemetry.lokiRange(
        query,
        window.seconds,
        Math.max(15, window.step),
      );
    } catch {
      return [];
    }
  }

  private async safeLokiLines(query: string, seconds: number) {
    try {
      return await this.telemetry.lokiLines(query, seconds, 200);
    } catch {
      return [];
    }
  }
}
