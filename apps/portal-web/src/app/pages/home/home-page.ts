import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { MatTab, MatTabGroup } from '@angular/material/tabs';
import { MatTooltip } from '@angular/material/tooltip';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { catchError, filter, map, startWith, switchMap, tap } from 'rxjs';
import { combineLatest, EMPTY, of, timer } from 'rxjs';
import { API_BASE_URL } from '../../core/api';
import { KioskService } from '../../core/kiosk';
import { TenantService } from '../../core/tenant';
import { ThemeService } from '../../core/theme';
import { EkuChartComponent } from '../../shared/eku/chart/eku-chart';
import { HomeChartAskComponent } from './home-chart-ask';
import { HomeTimeHelpComponent } from './home-time-help';
import { EkuEmptyStateComponent } from '../../shared/eku/empty-state/eku-empty-state';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuLoadingSkeletonComponent } from '../../shared/eku/loading-skeleton/eku-loading-skeleton';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';
import {
  areaOption,
  barWidth,
  diskDoughnutOption,
  formatAgo,
  formatNumber,
  formatPercent,
  formatRate,
  formatSize,
  formatUptime,
  logDetailPairs,
  logLevel,
  namedArea,
  connectionsByProtocol,
  cpuBreakdown,
  sparkArea,
  sparkPoints,
  stripLogTime,
  volumeFromLines,
  token,
  toneLabel,
  tonePercent,
  trendIcon,
  trendLabel,
  seriesTrend,
} from './dashboard-format';
import {
  DASHBOARD_RANGES,
  DASHBOARD_REFRESHES,
  persistTime,
  rangeLabel,
  rangeSeconds,
  readRange,
  readRefresh,
  refreshMs,
} from './dashboard-time';
import { CHART_HINTS } from './chart-hints';
import type { DashboardHostOption, DashboardResponse } from './dashboard.types';

type DashSection =
  | 'hosts'
  | 'host'
  | 'network'
  | 'agents'
  | 'agent'
  | 'databases'
  | 'queues'
  | 'icewarp'
  | 'icewarp-host'
  | 'sap';

const HOST_TABS = ['resumen', 'procesos', 'disco', 'red', 'logs'] as const;
const LOG_PAGE_SIZE = 20;

const TITLE_BY_SECTION: Record<DashSection, string> = {
  hosts: 'Hosts',
  host: 'Host',
  network: 'Red',
  agents: 'Agentes',
  agent: 'Agente',
  databases: 'Bases de datos',
  queues: 'Colas',
  icewarp: 'IceWarp',
  'icewarp-host': 'IceWarp',
  sap: 'SAP',
};

const MODULE_LABELS: Record<string, string> = {
  'metrics.host': 'Host',
  'metrics.processes': 'Procesos',
  'metrics.scrape': 'Scrape',
  'metrics.snmp': 'SNMP',
  'metrics.otlp': 'Métricas OTLP',
  databases: 'Bases de datos',
  queues: 'Colas',
  icewarp: 'IceWarp',
  logs: 'Logs',
  traces: 'Trazas',
  'ingest.syslog': 'Syslog',
  'ingest.netflow': 'NetFlow',
  'ingest.traps': 'Traps SNMP',
  'discovery.passive': 'Discovery',
  probes: 'Sondas',
  sap: 'Canal SAP',
};

function moduleLabel(module: string): string {
  return MODULE_LABELS[module] ?? module;
}

const MODE_LABELS: Record<string, string> = {
  site: 'Servidor',
  central: 'NOC',
  sensor: 'Sensor',
  endpoint: 'Endpoint',
};

type IdentityFact = { key: string; label: string; value: string; hint?: string };

@Component({
  selector: 'app-home-page',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatIcon,
    MatTabGroup,
    MatTab,
    MatTooltip,
    EkuPageHeaderComponent,
    EkuErrorStateComponent,
    EkuEmptyStateComponent,
    EkuLoadingSkeletonComponent,
    EkuChartComponent,
    HomeChartAskComponent,
    HomeTimeHelpComponent,
  ],
  templateUrl: './home-page.html',
  styleUrl: './home-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomePage {
  private readonly http = inject(HttpClient);
  private readonly theme = inject(ThemeService);
  private readonly kiosk = inject(KioskService);
  private readonly tenants = inject(TenantService);
  private readonly router = inject(Router);
  private refreshBeforeKiosk: string | null = null;
  private readonly path = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  protected readonly ranges = DASHBOARD_RANGES;
  protected readonly refreshes = DASHBOARD_REFRESHES;
  protected readonly agentControl = new FormControl('', { nonNullable: true });
  protected readonly rangeControl = new FormControl(readRange(), { nonNullable: true });
  protected readonly refreshControl = new FormControl(readRefresh(), { nonNullable: true });
  protected readonly logQuery = new FormControl('', { nonNullable: true });
  protected readonly processQuery = new FormControl('', { nonNullable: true });
  protected readonly processSortKey = signal<'name' | 'cpu' | 'memory' | 'disk'>('cpu');
  protected readonly processSortDir = signal<'asc' | 'desc'>('desc');
  protected readonly logSortKey = signal<'ts' | 'level' | 'line'>('ts');
  protected readonly logSortDir = signal<'asc' | 'desc'>('desc');
  protected readonly selectedLogKey = signal<string | null>(null);
  protected readonly logTimeFilter = signal<{ start: number; end: number } | null>(null);
  protected readonly hostTabIndex = signal(0);
  protected readonly logPage = signal(1);
  protected readonly logPageSize = LOG_PAGE_SIZE;
  private readonly logQueryValue = toSignal(
    this.logQuery.valueChanges.pipe(startWith(this.logQuery.value)),
    { initialValue: this.logQuery.value },
  );
  private readonly processQueryValue = toSignal(
    this.processQuery.valueChanges.pipe(startWith(this.processQuery.value)),
    { initialValue: this.processQuery.value },
  );
  protected readonly rangeId = signal(readRange());
  protected readonly refreshId = signal(readRefresh());
  protected readonly data = signal<DashboardResponse | null>(null);
  protected readonly hostSwitching = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly kioskOn = this.kiosk.active;
  protected readonly section = computed(() => this.sectionFrom(this.path() || this.router.url || '/'));
  protected readonly pageTitle = computed(() => {
    const routeId = this.entityIdFrom(this.path() || this.router.url || '');
    if (this.section() === 'host') {
      return routeId || this.hostTitle();
    }
    if (this.section() === 'agent') {
      return routeId || this.data()?.agentId || TITLE_BY_SECTION.agent;
    }
    if (this.section() === 'icewarp-host') {
      return this.icewarpTitle() || routeId || TITLE_BY_SECTION.icewarp;
    }
    return TITLE_BY_SECTION[this.section()];
  });
  protected readonly showDashTools = computed(
    () => this.section() === 'host' || this.section() === 'icewarp-host',
  );
  protected readonly showHostSelect = computed(
    () => this.showDashTools() && this.hosts().length > 0,
  );
  protected readonly inventoryHint = computed(() => {
    const section = this.section();
    if (section === 'hosts') {
      return `${this.hosts().length} hosts`;
    }
    if (section === 'network') {
      return `${this.networkDevices().length} equipos SNMP`;
    }
    if (section === 'agents') {
      return `${this.hosts().length} agentes`;
    }
    if (section === 'databases') {
      return `${this.databases().length} motores`;
    }
    if (section === 'queues') {
      return `${this.queues().length} colas`;
    }
    if (section === 'icewarp') {
      return `${this.icewarp().length} IceWarp`;
    }
    if (section === 'icewarp-host') {
      return `${this.icewarpTitle()} · ${this.rangeText()}`;
    }
    if (section === 'sap') {
      return `${this.sap().length} sistemas SAP`;
    }
    return `${this.hostTitle()} · ${this.rangeText()}`;
  });
  protected readonly hints = CHART_HINTS;
  protected readonly formatPercent = formatPercent;
  protected readonly formatNumber = formatNumber;
  protected readonly formatRate = formatRate;
  protected readonly formatUptime = formatUptime;
  protected readonly formatAgo = formatAgo;
  protected readonly formatSize = formatSize;
  protected readonly tonePercent = tonePercent;
  protected readonly toneLabel = toneLabel;
  protected readonly barWidth = barWidth;
  protected readonly sparkPoints = sparkPoints;
  protected readonly sparkArea = sparkArea;
  protected readonly trendIcon = trendIcon;
  protected readonly trendLabel = trendLabel;

  protected readonly hosts = computed((): DashboardHostOption[] => {
    const board = this.data();
    if (!board) {
      return [];
    }
    if (board.hosts?.length) {
      return board.hosts;
    }
    return (board.agents ?? []).map((item) => ({
      id: item.agentId,
      siteId: item.siteId,
      tenantId: item.tenantId,
      mode: null,
      version: null,
      online: null,
      cpuUsed: null,
      memoryUsed: null,
      uptimeSeconds: null,
      agentUptimeSeconds: null,
      cpus: null,
    }));
  });

  protected readonly nics = computed(() => this.data()?.nics ?? []);
  protected readonly databases = computed(() => this.data()?.databases ?? []);
  protected readonly networkDevices = computed(() => this.data()?.networkDevices ?? []);
  protected readonly queues = computed(() => this.data()?.queues ?? []);
  protected readonly icewarp = computed(() => this.data()?.icewarp ?? []);
  protected readonly icewarpBoard = computed(() => this.data()?.icewarpBoard ?? null);
  protected readonly icewarpTitle = computed(() => {
    const board = this.icewarpBoard();
    if (board?.name) {
      return board.name;
    }
    const hostId = this.entityIdFrom(this.path() || this.router.url || '');
    return this.icewarp().find((item) => item.hostId === hostId)?.name || hostId || 'IceWarp';
  });
  protected readonly icewarpSessionChart = computed(() =>
    namedArea(this.icewarpBoard()?.series.sessions ?? [], 'number', false),
  );
  protected readonly icewarpMemoryChart = computed(() =>
    namedArea(this.icewarpBoard()?.series.memory ?? [], 'bytes', false),
  );
  protected readonly icewarpSmtpChart = computed(() =>
    namedArea(this.icewarpBoard()?.series.smtp ?? [], 'number', false),
  );
  protected readonly icewarpDefenseChart = computed(() =>
    namedArea(this.icewarpBoard()?.series.defense ?? [], 'number', false),
  );
  protected readonly sap = computed(() => this.data()?.sap ?? []);
  protected readonly hostNics = computed(() => {
    const hostId = this.data()?.host.id;
    if (!hostId) {
      return [];
    }
    return this.nics().filter((item) => item.hostId === hostId);
  });
  protected readonly filteredLogs = computed(() => {
    const query = this.logQueryValue().trim().toLowerCase();
    const key = this.logSortKey();
    const dir = this.logSortDir() === 'asc' ? 1 : -1;
    const items = (this.data()?.logs.lines ?? []).map((item) => {
      const fields = item.fields ?? {};
      const message = stripLogTime(item.line);
      const level = logLevel(item.line, fields);
      const tsLabel = this.formatLogTime(item.ts);
      return {
        key: `${item.ts}|${item.line}`,
        ts: item.ts,
        tsLabel,
        line: item.line,
        message,
        level,
        fields,
        detail: logDetailPairs(tsLabel, message, level, fields),
      };
    });
    const window = this.logTimeFilter();
    const filtered = items.filter((item) => {
      if (window && (item.ts < window.start || item.ts > window.end)) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [item.message, item.level, item.tsLabel, ...Object.values(item.fields)]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
    return filtered.sort((left, right) => {
      const cmp =
        key === 'ts'
          ? left.ts - right.ts
          : key === 'level'
            ? left.level.localeCompare(right.level, 'es')
            : left.message.localeCompare(right.message, 'es');
      return cmp * dir;
    });
  });
  protected readonly selectedLog = computed(() => {
    const key = this.selectedLogKey();
    if (!key) {
      return null;
    }
    return this.filteredLogs().find((item) => item.key === key) ?? null;
  });
  protected readonly logPageCount = computed(() =>
    Math.max(1, Math.ceil(this.filteredLogs().length / LOG_PAGE_SIZE)),
  );
  protected readonly pagedLogs = computed(() => {
    const page = Math.min(this.logPage(), this.logPageCount());
    const start = (page - 1) * LOG_PAGE_SIZE;
    return this.filteredLogs().slice(start, start + LOG_PAGE_SIZE);
  });
  protected readonly logRangeLabel = computed(() => {
    const total = this.filteredLogs().length;
    if (total === 0) {
      return '0 de 0';
    }
    const page = Math.min(this.logPage(), this.logPageCount());
    const start = (page - 1) * LOG_PAGE_SIZE + 1;
    const end = Math.min(page * LOG_PAGE_SIZE, total);
    return `${start}-${end} de ${total}`;
  });

  protected readonly hostTitle = computed(() => {
    const host = this.data()?.host;
    if (!host?.id) {
      return 'Sin hosts';
    }
    return host.id;
  });

  protected hostLabel(item: { id: string; siteId: string | null }): string {
    return item.siteId ? `${item.siteId} · ${item.id}` : item.id;
  }

  protected modeLabel(mode?: string | null): string {
    if (!mode) {
      return 'sin datos';
    }
    return MODE_LABELS[mode] ?? mode;
  }

  protected nicKey(item: { hostId: string; device: string }): string {
    return `${item.hostId}|${item.device}`;
  }

  protected dbKey(item: { hostId: string; engine: string; name: string }): string {
    return `${item.hostId}|${item.engine}|${item.name}`;
  }

  protected readonly rangeText = computed(() => rangeLabel(this.rangeId()));

  protected readonly hostProcesses = computed(() => {
    const host = this.data()?.host;
    const items = host?.processes ?? [];
    const query = this.processQueryValue().trim().toLowerCase();
    const cpus = host?.cpus || 1;
    const memTotal = host?.memoryTotalBytes || 0;
    const filtered = query
      ? items.filter(
          (item) =>
            (item.name || '').toLowerCase().includes(query) || (item.pid || '').includes(query),
        )
      : items;
    const maxCpu = Math.max(...filtered.map((item) => item.cpu ?? 0), 0.01);
    const maxMem = Math.max(...filtered.map((item) => item.memoryBytes ?? 0), 1);
    const key = this.processSortKey();
    const dir = this.processSortDir() === 'asc' ? 1 : -1;
    return filtered
      .map((item) => ({
        ...item,
        cpuShare: (item.cpu ?? 0) / cpus,
        memShare: memTotal > 0 ? (item.memoryBytes ?? 0) / memTotal : 0,
        cpuBar: (item.cpu ?? 0) / maxCpu,
        memBar: (item.memoryBytes ?? 0) / maxMem,
        diskTotal: item.diskReadBytesPerSec + item.diskWriteBytesPerSec,
      }))
      .sort((left, right) => {
        const cmp =
          key === 'name'
            ? left.name.localeCompare(right.name, 'es') || left.pid.localeCompare(right.pid)
            : key === 'cpu'
              ? (left.cpu ?? 0) - (right.cpu ?? 0)
              : key === 'memory'
                ? (left.memoryBytes ?? 0) - (right.memoryBytes ?? 0)
                : left.diskTotal - right.diskTotal;
        return cmp * dir;
      });
  });

  protected sortProcesses(key: 'name' | 'cpu' | 'memory' | 'disk'): void {
    if (this.processSortKey() === key) {
      this.processSortDir.update((dir) => (dir === 'desc' ? 'asc' : 'desc'));
      return;
    }
    this.processSortKey.set(key);
    this.processSortDir.set(key === 'name' ? 'asc' : 'desc');
  }

  protected processSortAria(key: 'name' | 'cpu' | 'memory' | 'disk'): string {
    if (this.processSortKey() !== key) {
      return 'none';
    }
    return this.processSortDir() === 'asc' ? 'ascending' : 'descending';
  }

  protected readonly identity = computed((): IdentityFact[] => {
    const board = this.data();
    const ident = board?.agent.identity ?? {};
    const tenantSlug = ident['tenant_id'] ?? board?.host.tenantId ?? this.tenants.slug();
    const siteSlug = ident['site_id'] ?? board?.host.siteId ?? '';
    const agentId = ident['agent_id'] ?? board?.agentId ?? '';
    const mode = ident['mode'] ?? '';
    const environment = ident['environment'] ?? '';
    const tenant =
      this.tenants.tenants().find((item) => item.slug === tenantSlug) ?? this.tenants.current();
    const site = tenant?.sites?.find((item) => item.slug === siteSlug);
    const facts: IdentityFact[] = [
      { key: 'agent', label: 'agente', value: agentId },
      {
        key: 'tenant',
        label: 'tenant',
        value: tenant?.name || tenantSlug,
        hint: tenant?.name && tenant.slug !== tenant.name ? tenant.slug : undefined,
      },
      {
        key: 'site',
        label: 'sitio',
        value: site?.name || siteSlug,
        hint: site?.name && site.slug !== site.name ? site.slug : undefined,
      },
      {
        key: 'mode',
        label: 'tipo',
        value: MODE_LABELS[mode] ?? mode,
        hint: MODE_LABELS[mode] ? mode : undefined,
      },
      { key: 'env', label: 'entorno', value: environment },
    ];
    return facts.filter((item) => item.value.trim().length > 0);
  });

  protected readonly agentModules = computed(() => {
    const items = this.data()?.agent.modules ?? [];
    return [...items]
      .map((item) => ({ ...item, label: moduleLabel(item.module) }))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.label.localeCompare(b.label, 'es'));
  });

  protected readonly cpuTrend = computed(() => seriesTrend(this.data()?.host.series.cpu ?? []));

  protected readonly cpuStates = computed(() => cpuBreakdown(this.data()?.host.series.cpuByState ?? []));

  protected readonly cpuIdle = computed(() => {
    const used = this.data()?.host.cpuUsed;
    if (used === null || used === undefined) {
      return 1;
    }
    return Math.max(0, 1 - used);
  });

  protected readonly cpuLoadShare = computed(() => {
    const host = this.data()?.host;
    if (!host?.cpus || host.load1m === null) {
      return null;
    }
    return host.load1m / host.cpus;
  });

  protected readonly chartRangeMs = computed(() => rangeSeconds(this.rangeId()) * 1000);

  protected readonly chartStripKey = computed(
    () => this.data()?.agentId || this.data()?.host.id || this.agentControl.value || '',
  );

  protected readonly cpuChart = computed(() => {
    this.theme.mode();
    const states = this.data()?.host.series.cpuByState ?? [];
    if (states.length) {
      return namedArea(states, 'percent', true);
    }
    return areaOption(
      [{ name: 'CPU', points: this.data()?.host.series.cpu ?? [], color: token('--eku-chart-series') }],
      'percent',
    );
  });

  protected readonly loadChart = computed(() => {
    this.theme.mode();
    const series = this.data()?.host.series;
    return areaOption(
      [
        { name: '1m', points: series?.load1 ?? [], color: token('--eku-chart-series') },
        { name: '5m', points: series?.load5 ?? [], color: token('--eku-chart-2') },
        { name: '15m', points: series?.load15 ?? [], color: token('--eku-chart-3') },
      ],
      'number',
    );
  });

  protected readonly memoryChart = computed(() => {
    this.theme.mode();
    return namedArea(this.data()?.host.series.memoryByState ?? [], 'bytes', true);
  });

  protected readonly diskChart = computed(() => {
    this.theme.mode();
    const host = this.data()?.host;
    return diskDoughnutOption(
      host?.diskUsedBytes ?? null,
      host?.diskTotalBytes ?? null,
      host?.diskUsed ?? null,
    );
  });

  protected readonly networkChart = computed(() => {
    this.theme.mode();
    const host = this.data()?.host.series;
    return areaOption(
      [
        { name: 'RX', points: host?.networkRx ?? [], color: token('--eku-chart-series') },
        { name: 'TX', points: host?.networkTx ?? [], color: token('--eku-chart-3') },
      ],
      'bytesRate',
    );
  });

  protected readonly diskIoChart = computed(() => {
    this.theme.mode();
    return namedArea(this.data()?.host.series.diskIo ?? [], 'bytesRate', false);
  });

  protected readonly diskOpsChart = computed(() => {
    this.theme.mode();
    return namedArea(this.data()?.host.series.diskOps ?? [], 'number', false);
  });

  protected readonly packetsChart = computed(() => {
    this.theme.mode();
    return namedArea(this.data()?.host.series.networkPackets ?? [], 'number', false);
  });

  protected readonly netFaultChart = computed(() => {
    this.theme.mode();
    return namedArea(this.data()?.host.series.networkFaults ?? [], 'number', false);
  });

  protected readonly tcpConnChart = computed(() => {
    this.theme.mode();
    return namedArea(connectionsByProtocol(this.data()?.host.series.networkConn ?? [], 'tcp'), 'number', false);
  });

  protected readonly otherConnChart = computed(() => {
    this.theme.mode();
    return namedArea(connectionsByProtocol(this.data()?.host.series.networkConn ?? [], 'other'), 'number', false);
  });

  protected readonly logVolume = computed(() => volumeFromLines(this.data()?.logs.lines ?? []));

  protected readonly volumeChart = computed(() => {
    this.theme.mode();
    return areaOption(
      [{ name: 'Logs', points: this.logVolume().points, color: token('--eku-chart-series') }],
      'number',
    );
  });

  constructor() {
    effect(() => {
      this.logQueryValue();
      this.logPage.set(1);
      this.selectedLogKey.set(null);
    });

    effect(() => {
      const tab = new URLSearchParams((this.path() || this.router.url).split('?')[1] ?? '').get('tab');
      const index = HOST_TABS.indexOf((tab as (typeof HOST_TABS)[number]) ?? 'resumen');
      this.hostTabIndex.set(index >= 0 ? index : 0);
    });

    effect(() => {
      if (this.kiosk.active()) {
        this.refreshBeforeKiosk = this.refreshControl.value;
        if (this.refreshControl.value === 'off') {
          this.refreshControl.setValue('30s');
        }
        return;
      }
      if (this.refreshBeforeKiosk === 'off') {
        this.refreshControl.setValue('off');
      }
      this.refreshBeforeKiosk = null;
    });

    combineLatest([
      this.rangeControl.valueChanges.pipe(startWith(this.rangeControl.value)),
      this.refreshControl.valueChanges.pipe(startWith(this.refreshControl.value)),
      this.agentControl.valueChanges.pipe(startWith(this.agentControl.value)),
      this.router.events.pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        map((event) => event.urlAfterRedirects),
        startWith(this.router.url),
      ),
      toObservable(this.tenants.slug),
    ])
      .pipe(
        switchMap(([range, refresh, agentId, url]) => {
          this.rangeId.set(range);
          this.refreshId.set(refresh);
          persistTime(range, refresh);
          const section = this.sectionFrom(url);
          const routeId = this.entityIdFrom(url);
          if ((section === 'host' || section === 'agent') && agentId && routeId && agentId !== routeId) {
            void this.router.navigate([section === 'agent' ? '/agentes' : '/hosts', agentId], {
              replaceUrl: true,
            });
          }
          const hostId =
            routeId || (section === 'host' || section === 'agent' || section === 'icewarp-host' ? agentId : '');
          const shown =
            section === 'icewarp-host'
              ? (this.data()?.icewarpBoard?.hostId ?? '')
              : (this.data()?.host.id ?? this.data()?.agentId ?? '');
          const switchingHost =
            (section === 'host' || section === 'agent' || section === 'icewarp-host') &&
            Boolean(shown && hostId && shown !== hostId);
          if (switchingHost) {
            this.hostSwitching.set(true);
          }
          const ms = refreshMs(refresh);
          const ticks = ms <= 0 ? of(0) : timer(0, ms);
          return ticks.pipe(
            switchMap((_tick, index) => {
              const req = this.dashboardRequest(
                hostId || undefined,
                range,
                section === 'icewarp-host' ? 'icewarp' : undefined,
              );
              if (switchingHost && index === 0) {
                return timer(180).pipe(switchMap(() => req));
              }
              return req;
            }),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe();
  }

  protected onHostTab(index: number): void {
    if (this.hostTabIndex() === index) {
      return;
    }
    this.hostTabIndex.set(index);
    const tab = HOST_TABS[index] ?? 'resumen';
    void this.router.navigate([], {
      queryParams: { tab: tab === 'resumen' ? null : tab },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected sortLogs(key: 'ts' | 'level' | 'line'): void {
    if (this.logSortKey() === key) {
      this.logSortDir.update((dir) => (dir === 'desc' ? 'asc' : 'desc'));
      return;
    }
    this.logSortKey.set(key);
    this.logSortDir.set(key === 'line' ? 'asc' : 'desc');
  }

  protected logSortAria(key: 'ts' | 'level' | 'line'): string {
    if (this.logSortKey() !== key) {
      return 'none';
    }
    return this.logSortDir() === 'asc' ? 'ascending' : 'descending';
  }

  protected selectLog(key: string): void {
    this.selectedLogKey.update((current) => (current === key ? null : key));
  }

  protected closeLog(): void {
    this.selectedLogKey.set(null);
  }

  protected pickLogVolume(tsMs: number): void {
    const { points, stepMs } = this.logVolume();
    if (points.length === 0) {
      return;
    }
    const picked = this.toMs(tsMs);
    let idx = 0;
    let best = Math.abs(this.toMs(points[0][0]) - picked);
    for (let i = 1; i < points.length; i += 1) {
      const dist = Math.abs(this.toMs(points[i][0]) - picked);
      if (dist < best) {
        best = dist;
        idx = i;
      }
    }
    const start = this.toMs(points[idx][0]);
    this.logTimeFilter.set({ start, end: start + stepMs - 1 });
    this.logPage.set(1);
    this.selectedLogKey.set(null);
  }

  private toMs(ts: number): number {
    if (ts > 1e14) {
      return Math.floor(ts / 1e6);
    }
    if (ts > 1e12) {
      return Math.floor(ts);
    }
    return Math.floor(ts * 1000);
  }

  protected clearLogTime(): void {
    this.logTimeFilter.set(null);
  }

  protected logTimeLabel(): string {
    const window = this.logTimeFilter();
    if (!window) {
      return '';
    }
    return `${this.formatLogTime(window.start)} – ${this.formatLogTime(window.end)}`;
  }

  protected prevLogPage(): void {
    this.logPage.update((page) => Math.max(1, page - 1));
  }

  protected nextLogPage(): void {
    this.logPage.update((page) => Math.min(this.logPageCount(), page + 1));
  }

  protected formatLogTime(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  protected highlightLog(text: string): Array<{ value: string; hit: boolean }> {
    const query = this.logQueryValue().trim();
    if (!query || !text) {
      return [{ value: text, hit: false }];
    }
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
    return parts
      .filter((value) => value.length > 0)
      .map((value) => ({
        value,
        hit: value.toLowerCase() === query.toLowerCase(),
      }));
  }

  protected icewarpPort(name: string): string {
    const port = name.split('-').pop() ?? name;
    const labels: Record<string, string> = {
      '25': 'SMTP 25',
      '587': 'Submission 587',
      '143': 'IMAP 143',
      '993': 'IMAPS 993',
      '443': 'HTTPS 443',
    };
    return labels[port] || name;
  }

  protected askText(topic: string): string {
    const range = this.rangeText();
    if (this.section() === 'icewarp-host') {
      const name = this.icewarpTitle();
      return `analiza ${topic} de IceWarp ${name} en ${range}`;
    }
    const host = this.hostTitle();
    const where = host !== 'Sin hosts' ? ` del host ${host}` : '';
    return `analiza ${topic}${where} en ${range}`;
  }

  protected askLogText(item: { tsLabel: string; level: string; message: string }): string {
    const host = this.hostTitle();
    const where = host !== 'Sin hosts' ? ` del host ${host}` : '';
    const level = item.level ? ` nivel ${item.level}` : '';
    return `analiza este log${where}${level} y dime que puede ser el problema: ${item.tsLabel} ${item.message}`;
  }

  protected reload(): void {
    this.dashboardRequest(
      this.agentControl.value || undefined,
      this.rangeControl.value,
      this.section() === 'icewarp-host' ? 'icewarp' : undefined,
    ).subscribe();
  }

  protected toggleKiosk(): void {
    this.kiosk.toggle();
  }

  private entityIdFrom(url: string): string | null {
    const path = url.split('?')[0];
    const host = path.match(/^\/hosts\/([^/]+)$/);
    if (host?.[1]) {
      return decodeURIComponent(host[1]);
    }
    const agent = path.match(/^\/agentes\/([^/]+)$/);
    if (agent?.[1]) {
      return decodeURIComponent(agent[1]);
    }
    const icewarp = path.match(/^\/icewarp\/([^/]+)$/);
    if (icewarp?.[1]) {
      return decodeURIComponent(icewarp[1]);
    }
    return null;
  }

  private sectionFrom(url: string): DashSection {
    const path = url.split('?')[0];
    if (path.startsWith('/red')) {
      return 'network';
    }
    if (/^\/agentes\/[^/]+/.test(path)) {
      return 'agent';
    }
    if (path.startsWith('/agentes')) {
      return 'agents';
    }
    if (path.startsWith('/bases-de-datos')) {
      return 'databases';
    }
    if (path.startsWith('/colas')) {
      return 'queues';
    }
    if (/^\/icewarp\/[^/]+/.test(path)) {
      return 'icewarp-host';
    }
    if (path.startsWith('/icewarp')) {
      return 'icewarp';
    }
    if (path.startsWith('/sap')) {
      return 'sap';
    }
    if (/^\/hosts\/[^/]+/.test(path)) {
      return 'host';
    }
    return 'hosts';
  }

  private dashboardRequest(agentId?: string, range = this.rangeControl.value, view?: string) {
    const query = new URLSearchParams();
    if (agentId) {
      query.set('host_id', agentId);
    }
    if (view) {
      query.set('view', view);
    }
    const tenantId = this.tenants.slug();
    if (tenantId) {
      query.set('tenant_id', tenantId);
    }
    query.set('range', range);
    return this.http.get<DashboardResponse>(`${API_BASE_URL}/v1/dashboard?${query.toString()}`).pipe(
      tap((value) => {
        this.data.set(value);
        this.error.set(null);
        const selectedHost = value.host.id ?? value.agentId;
        if (selectedHost && selectedHost !== this.agentControl.value) {
          this.agentControl.setValue(selectedHost, { emitEvent: false });
        }
        if (this.hostSwitching()) {
          requestAnimationFrame(() => this.hostSwitching.set(false));
        }
      }),
      catchError(() => {
        this.hostSwitching.set(false);
        if (!this.data()) {
          this.error.set('No se pudieron leer las series. Compruebe Prometheus y la API.');
        }
        return EMPTY;
      }),
    );
  }
}
