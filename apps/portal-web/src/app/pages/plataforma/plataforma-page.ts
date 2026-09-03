import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { debounceTime, distinctUntilChanged, map, merge, startWith, timer } from 'rxjs';
import { API_BASE_URL } from '../../core/api';
import { areaOption, logLevel } from '../home/dashboard-format';
import { EkuChartComponent } from '../../shared/eku/chart/eku-chart';
import { EkuEmptyStateComponent } from '../../shared/eku/empty-state/eku-empty-state';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuLoadingSkeletonComponent } from '../../shared/eku/loading-skeleton/eku-loading-skeleton';
import { EkuHelpTipComponent } from '../../shared/eku/help-tip/eku-help-tip';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';

type SeriesPoint = [number, number];

type PlatformOverview = {
  host: {
    hostname: string | null;
    os: string | null;
    kernel: string | null;
    arch: string | null;
    uptimeSeconds: number | null;
    cpus: number | null;
    load1: number | null;
    load5: number | null;
    load15: number | null;
    cpuUsed: number | null;
    memUsed: number | null;
    memTotalBytes: number | null;
    memAvailBytes: number | null;
    swapUsed: number | null;
    diskUsed: number | null;
    diskAvailBytes: number | null;
    diskTotalBytes: number | null;
    nics: Array<{
      device: string;
      rxBytesPerSec: number | null;
      txBytesPerSec: number | null;
    }>;
    netRxBytesPerSec: number | null;
    netTxBytesPerSec: number | null;
    netErrorsPerSec: number | null;
    netDropsPerSec: number | null;
    diskReadBytesPerSec: number | null;
    diskWriteBytesPerSec: number | null;
    tcpEstablished: number | null;
  };
  services: Array<{ job: string; instance: string; label: string; up: boolean }>;
  slo: {
    availability: number | null;
    errorBudget: number | null;
    latency: number | null;
    freshness: number | null;
    saturation: {
      value: number | null;
      cpu: number | null;
      memory: number | null;
      disk: number | null;
      driver: 'cpu' | 'memoria' | 'disco' | null;
    };
  };
  api: {
    requestsPerSec: number | null;
    errorRatio: number | null;
    p95Seconds: number | null;
  };
  series: {
    cpu: SeriesPoint[];
    memory: SeriesPoint[];
    disk: SeriesPoint[];
    netRx: SeriesPoint[];
    netTx: SeriesPoint[];
    rps: SeriesPoint[];
  };
  logs: Array<{ ts: number; line: string; fields: Record<string, string> }>;
  traces: Array<{
    traceId: string;
    rootServiceName: string;
    rootTraceName: string;
    durationMs: number;
  }>;
  thresholds?: PlatformThresholds;
  updatedAt: string;
};

type PlatformThresholds = {
  availabilityWarn: number;
  availabilityCrit: number;
  errorBudgetWarn: number;
  errorBudgetCrit: number;
  latencyWarn: number;
  latencyCrit: number;
  freshnessWarn: number;
  freshnessCrit: number;
  saturationWarn: number;
  saturationCrit: number;
  cpuWarn: number;
  cpuCrit: number;
  memWarn: number;
  memCrit: number;
  diskWarn: number;
  diskCrit: number;
  netWarn: number;
  netCrit: number;
  errorsWarn: number;
  errorsCrit: number;
  p95Warn: number;
  p95Crit: number;
};

const DEFAULT_THRESHOLDS: PlatformThresholds = {
  availabilityWarn: 0.01,
  availabilityCrit: 0.05,
  errorBudgetWarn: 0.5,
  errorBudgetCrit: 1,
  latencyWarn: 0.05,
  latencyCrit: 0.15,
  freshnessWarn: 0.01,
  freshnessCrit: 0.05,
  saturationWarn: 0.8,
  saturationCrit: 1,
  cpuWarn: 0.7,
  cpuCrit: 0.9,
  memWarn: 0.8,
  memCrit: 0.9,
  diskWarn: 0.7,
  diskCrit: 0.85,
  netWarn: 0.1,
  netCrit: 1,
  errorsWarn: 0.01,
  errorsCrit: 0.05,
  p95Warn: 0.5,
  p95Crit: 1,
};

type PlatformLog = PlatformOverview['logs'][number];

const LOG_PAGE_SIZES = [10, 25, 50, 100] as const;
const LOG_LEVELS = ['todos', 'error', 'warning', 'info', 'debug'] as const;

function localDateTime(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const LOG_LEVEL_FIELD = ['detected_level', 'level', 'severity', 'lvl'];
const LOG_LEVEL_IN_LINE =
  /\b(debug|info|notice|warn|warning|war|error|err|fatal|crit|critical|trace|emerg|alert)\b/i;

function normalizeLevel(value: string): string {
  const level = value.trim().toLowerCase();
  if (level === 'warn' || level === 'war' || level === 'warning') return 'warning';
  if (level === 'err' || level === 'error' || level === 'fatal' || level === 'crit' || level === 'critical' || level === 'emerg' || level === 'alert') {
    return 'error';
  }
  if (level === 'notice' || level === 'log') return 'info';
  return level;
}

const HINTS = {
  availability:
    'Porcentaje de tiempo y respuestas correctas de la API en los últimos 5 minutos. El objetivo es 99,9 %.',
  errorBudget:
    'Cuánto del error budget (0,1 %) se está gastando ahora. 0 % = intacto. 100 %+ = agotado.',
  latency:
    'Porcentaje de peticiones a la API que terminan en menos de 500 ms. Por debajo del 95 % la interfaz se siente lenta.',
  freshness:
    'Porcentaje de agentes que enviaron datos en los últimos 5 minutos. Si no hay agentes se muestra 100 %.',
  saturation:
    'Lo peor entre cola de CPU (load 1 / núcleos), memoria y disco. 100 % = saturado. No es el uso medio: es si el host ya no da abasto.',
  cpu: 'Uso de CPU del host. Load 1/5/15 es la cola de trabajo a 1, 5 y 15 minutos. Si el load supera el número de núcleos, el host va saturado.',
  memory:
    'Memoria RAM ocupada del host. Libre es lo que el sistema aún puede dar a la API, Grafana o Prometheus. Swap alto indica que la RAM no alcanza.',
  disk: 'Espacio usado en el disco del host. Libre bajo (< 15 %) pone en riesgo Prometheus, Loki y PostgreSQL. Lect./escr. es la actividad de disco.',
  network:
    'Bajada es el tráfico que entra al host. Subida es el que sale. Si hay varias interfaces se listan aparte. Err y drop son fallos de red. TCP son conexiones establecidas.',
  requests: 'Peticiones por segundo que atiende la API, sin /metrics ni /health.',
  errors: 'Porcentaje de respuestas 5xx. Cerca de 0 % es lo esperado.',
  p95: 'El 95 % de las peticiones tarda menos que este valor. Si supera 500 ms, el portal se siente lento.',
  uptime: 'Uptime del host desde el último arranque.',
  hostChart: 'Evolución de la última hora: CPU, memoria y disco del host de E-Platform.',
  netChart: 'Bytes por segundo de entrada (RX) y salida (TX) de la interfaz principal del host.',
  apiChart: 'Peticiones por segundo a la API en la última hora.',
  logs: 'Salida de los contenedores ekumetrics-* enviada a Loki. Filtre por texto, nivel y rango de fecha.',
  traces:
    'Llamadas recientes de la API registradas en Tempo. Sirven para ver qué operación tardó y con qué trace id.',
} as const;

@Component({
  selector: 'app-plataforma-page',
  imports: [
    DatePipe,
    ReactiveFormsModule,
    MatIcon,
    EkuChartComponent,
    EkuEmptyStateComponent,
    EkuErrorStateComponent,
    EkuHelpTipComponent,
    EkuLoadingSkeletonComponent,
    EkuPageHeaderComponent,
  ],
  templateUrl: './plataforma-page.html',
  styleUrl: './plataforma-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlataformaPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly data = signal<PlatformOverview | null>(null);
  protected readonly loading = signal(true);
  protected readonly refreshing = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly logPage = signal(1);
  protected readonly openLogKey = signal<string | null>(null);
  protected readonly logRows = signal<PlatformLog[]>([]);
  protected readonly logPageSizes = LOG_PAGE_SIZES;
  protected readonly logLevels = LOG_LEVELS;
  protected readonly hints = HINTS;
  protected readonly logsForm = this.fb.nonNullable.group({
    query: [''],
    level: ['todos' as (typeof LOG_LEVELS)[number], Validators.required],
    from: [localDateTime(Date.now() - 3_600_000), Validators.required],
    to: [localDateTime(Date.now()), Validators.required],
    pageSize: [10, [Validators.required, Validators.min(10)]],
  });
  private readonly logsFormValue = toSignal(
    this.logsForm.valueChanges.pipe(startWith(this.logsForm.getRawValue())),
    { initialValue: this.logsForm.getRawValue() },
  );

  protected readonly hostChart = computed(() => {
    const series = this.data()?.series;
    if (!series) return null;
    return areaOption(
      [
        { name: 'CPU %', points: series.cpu },
        { name: 'Memoria %', points: series.memory },
        { name: 'Disco %', points: series.disk },
      ],
      'percent',
    );
  });

  protected readonly netChart = computed(() => {
    const series = this.data()?.series;
    if (!series) return null;
    return areaOption(
      [
        { name: 'Bajada', points: series.netRx },
        { name: 'Subida', points: series.netTx },
      ],
      'bytesRate',
    );
  });

  protected readonly apiChart = computed(() => {
    const series = this.data()?.series;
    if (!series) return null;
    return areaOption([{ name: 'Solicitudes/s', points: series.rps }], 'number');
  });

  protected readonly thresholds = computed(() => ({
    ...DEFAULT_THRESHOLDS,
    ...this.data()?.thresholds,
  }));

  protected invert(value: number | null): number | null {
    return value === null ? null : 1 - value;
  }

  protected readonly filteredLogs = computed(() => {
    const query = (this.logsFormValue().query ?? '').trim().toLowerCase();
    const level = this.logsFormValue().level ?? 'todos';
    return this.logRows().filter((item) => {
      if (level !== 'todos' && this.levelOf(item) !== level) {
        return false;
      }
      if (!query) {
        return true;
      }
      const service = this.service(item.fields).toLowerCase();
      return (
        item.line.toLowerCase().includes(query) ||
        service.includes(query) ||
        this.levelOf(item).includes(query) ||
        Object.values(item.fields).some((value) => value.toLowerCase().includes(query))
      );
    });
  });

  protected readonly logPageSize = computed(() => {
    const size = Number(this.logsFormValue().pageSize);
    return LOG_PAGE_SIZES.includes(size as (typeof LOG_PAGE_SIZES)[number]) ? size : 10;
  });

  protected readonly logPageCount = computed(() =>
    Math.max(1, Math.ceil(this.filteredLogs().length / this.logPageSize())),
  );

  protected readonly logPageView = computed(() => Math.min(this.logPage(), this.logPageCount()));

  protected readonly pagedLogs = computed(() => {
    const page = this.logPageView();
    const size = this.logPageSize();
    const start = (page - 1) * size;
    return this.filteredLogs().slice(start, start + size);
  });

  protected readonly logRangeLabel = computed(() => {
    const total = this.filteredLogs().length;
    if (total === 0) {
      return '0 de 0';
    }
    const page = this.logPageView();
    const size = this.logPageSize();
    const start = (page - 1) * size + 1;
    const end = Math.min(page * size, total);
    return `${start}-${end} de ${total}`;
  });

  constructor() {
    timer(0, 30_000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.reload());
    this.logsForm.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.logPage.set(1);
      this.openLogKey.set(null);
    });
    merge(this.logsForm.controls.from.valueChanges, this.logsForm.controls.to.valueChanges)
      .pipe(
        debounceTime(400),
        map(() => `${this.logsForm.controls.from.value}|${this.logsForm.controls.to.value}`),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.reloadLogs());
  }

  protected reload(): void {
    if (this.data()) {
      this.refreshing.set(true);
    } else {
      this.loading.set(true);
    }
    this.http.get<PlatformOverview>(`${API_BASE_URL}/v1/platform/overview`).subscribe({
      next: (overview) => {
        this.data.set(overview);
        this.error.set(null);
        this.loading.set(false);
        this.refreshing.set(false);
        this.reloadLogs();
      },
      error: (err: { error?: { message?: string } }) => {
        this.error.set(err.error?.message ?? 'No se pudo cargar E-Platform.');
        this.loading.set(false);
        this.refreshing.set(false);
      },
    });
  }

  protected reloadLogs(): void {
    const from = Date.parse(this.logsForm.controls.from.value);
    const to = Date.parse(this.logsForm.controls.to.value);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      this.logRows.set([]);
      return;
    }
    this.http
      .get<PlatformLog[]>(`${API_BASE_URL}/v1/platform/logs`, {
        params: {
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
        },
      })
      .subscribe({
        next: (rows) => this.logRows.set(rows),
        error: () => this.logRows.set([]),
      });
  }

  protected tone(value: number | null, warn: number, crit: number): string {
    if (value === null) return '';
    if (value >= crit) return 'is-crit';
    if (value >= warn) return 'is-warn';
    return 'is-ok';
  }

  protected isOk(value: number | null, warn: number, crit: number): boolean {
    return this.tone(value, warn, crit) === 'is-ok';
  }

  protected isWarn(value: number | null, warn: number, crit: number): boolean {
    return this.tone(value, warn, crit) === 'is-warn';
  }

  protected isCrit(value: number | null, warn: number, crit: number): boolean {
    return this.tone(value, warn, crit) === 'is-crit';
  }

  protected pct(value: number | null): string {
    return value === null ? '—' : `${(value * 100).toFixed(1)} %`;
  }

  protected budgetPct(value: number | null): string {
    if (value === null) return '—';
    if (value >= 1) return '100 %+';
    return `${(value * 100).toFixed(1)} %`;
  }

  protected num(value: number | null, digits = 2): string {
    return value === null ? '—' : value.toFixed(digits);
  }

  protected bytes(value: number | null): string {
    if (value === null) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = Math.max(0, value);
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  protected rate(value: number | null): string {
    return value === null ? '—' : `${this.bytes(value)}/s`;
  }

  protected uptime(value: number | null): string {
    if (value === null) return '—';
    const days = Math.floor(value / 86_400);
    const hours = Math.floor((value % 86_400) / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  protected ms(value: number | null): string {
    return value === null ? '—' : `${Math.round(value * 1000)} ms`;
  }

  protected service(fields: Record<string, string>): string {
    return fields['service_name'] ?? fields['container'] ?? fields['job'] ?? 'host';
  }

  protected levelOf(item: PlatformLog): string {
    for (const key of LOG_LEVEL_FIELD) {
      const raw = item.fields[key]?.trim();
      if (raw) {
        return normalizeLevel(raw);
      }
    }
    const marked = logLevel(item.line, item.fields);
    if (marked) {
      return marked;
    }
    const found = item.line.match(LOG_LEVEL_IN_LINE);
    if (found?.[1]) {
      return normalizeLevel(found[1]);
    }
    if (item.fields['stream'] === 'stderr') {
      return 'error';
    }
    return 'info';
  }

  protected logPairs(item: PlatformLog): Array<[string, string]> {
    return Object.entries(item.fields)
      .filter(([, value]) => Boolean(value?.trim()))
      .sort(([left], [right]) => left.localeCompare(right, 'en'));
  }

  protected isLogOpen(item: PlatformLog, index: number): boolean {
    return this.openLogKey() === this.logKey(item, index);
  }

  protected toggleLog(item: PlatformLog, index: number): void {
    const key = this.logKey(item, index);
    this.openLogKey.update((current) => (current === key ? null : key));
  }

  protected prevLogPage(): void {
    this.logPage.update((page) => Math.max(1, page - 1));
    this.openLogKey.set(null);
  }

  protected nextLogPage(): void {
    this.logPage.update((page) => Math.min(this.logPageCount(), page + 1));
    this.openLogKey.set(null);
  }

  protected highlightLog(text: string): Array<{ value: string; hit: boolean }> {
    const query = (this.logsFormValue().query ?? '').trim();
    if (!query || !text) {
      return [{ value: text, hit: false }];
    }
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text
      .split(new RegExp(`(${escaped})`, 'gi'))
      .filter((value) => value.length > 0)
      .map((value) => ({
        value,
        hit: value.toLowerCase() === query.toLowerCase(),
      }));
  }

  protected logKey(item: PlatformLog, index: number): string {
    return `${item.ts}|${index}|${item.line}`;
  }
}
