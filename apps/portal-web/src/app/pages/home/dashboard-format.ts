import type { EChartsOption } from 'echarts';
import { timeAxisLabel, timeAxisStep, timeAxisTicks } from '../../shared/eku/chart/time-axis';
import type { NamedSeries, SeriesPoint } from './dashboard.types';

export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function formatPercent(value: number | null): string {
  if (value === null) {
    return 'sin datos';
  }
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

export function formatNumber(value: number | null, digits = 0): string {
  if (value === null) {
    return 'sin datos';
  }
  return value.toFixed(digits);
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null) {
    return 'sin datos';
  }
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (total < 60) {
    return `${total}s`;
  }
  return `${minutes}m`;
}

export function formatAgo(seconds: number | null): string {
  if (seconds === null) {
    return 'sin datos';
  }
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) {
    return `hace ${total}s`;
  }
  if (total < 3600) {
    return `hace ${Math.floor(total / 60)}m`;
  }
  return `hace ${Math.floor(total / 3600)}h`;
}

export function formatBytesRate(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)} MB/s`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} KB/s`;
  }
  return `${value.toFixed(0)} B/s`;
}

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) {
    return 'sin datos';
  }
  if (bytes >= 1_073_741_824) {
    return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  }
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(0)} MB`;
  }
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) {
    return 'sin datos';
  }
  return `${formatSize(bytesPerSec)}/s`;
}

const LOG_TIME_MARK =
  /\[?\d{4}[/-]\d{2}[/-]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*/g;
const LOG_SYSLOG_PREFIX = /^[A-Za-záéíóú]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+/i;
const LOG_LEVEL_MARK = /\[\s*(debug|info|warn|warning|error|trace|fatal)\s*\]/i;
const LOG_PRIORITY: Record<string, string> = {
  '0': 'emerg',
  '1': 'alert',
  '2': 'crit',
  '3': 'error',
  '4': 'warning',
  '5': 'notice',
  '6': 'info',
  '7': 'debug',
};
const LOG_DETAIL_FIELDS: Array<[string, string]> = [
  ['SYSLOG_IDENTIFIER', 'identificador'],
  ['_HOSTNAME', 'host'],
  ['_PID', 'pid'],
  ['_COMM', 'proceso'],
  ['_SYSTEMD_UNIT', 'unidad'],
  ['_CMDLINE', 'comando'],
];

export function stripLogTime(line: string): string {
  return line.replace(LOG_TIME_MARK, '').replace(LOG_SYSLOG_PREFIX, '').trim();
}

export function logLevel(line: string, fields: Record<string, string> = {}): string {
  const marked = line.match(LOG_LEVEL_MARK);
  if (marked?.[1]) {
    const value = marked[1].toLowerCase();
    return value === 'warn' ? 'warning' : value;
  }
  return LOG_PRIORITY[fields['PRIORITY']] ?? '';
}

export function logDetailPairs(
  tsLabel: string,
  message: string,
  level: string,
  fields: Record<string, string>,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [
    ['fecha', tsLabel],
    ['nivel', level || 'sin nivel'],
  ];
  for (const [key, label] of LOG_DETAIL_FIELDS) {
    const value = fields[key]?.trim();
    if (value) {
      pairs.push([label, value]);
    }
  }
  pairs.push(['mensaje', message]);
  return pairs;
}

export function tonePercent(value: number | null, warn: number, crit: number): string {
  if (value === null) {
    return '';
  }
  if (value >= crit) {
    return 'is-crit';
  }
  if (value >= warn) {
    return 'is-warn';
  }
  return 'is-ok';
}

export function toneLabel(value: number | null, warn: number, crit: number): string {
  if (value === null) {
    return 'Sin datos';
  }
  if (value >= crit) {
    return 'Critico';
  }
  if (value >= warn) {
    return 'Alto';
  }
  return 'Normal';
}

export function lastPoint(points: SeriesPoint[]): number | null {
  if (points.length === 0) {
    return null;
  }
  return points[points.length - 1][1];
}

export function seriesTrend(points: SeriesPoint[]): 'up' | 'down' | 'flat' | null {
  if (points.length < 2) {
    return null;
  }
  const prev = points[points.length - 2][1];
  const next = points[points.length - 1][1];
  const delta = next - prev;
  if (Math.abs(delta) < 0.01) {
    return 'flat';
  }
  return delta > 0 ? 'up' : 'down';
}

export function trendLabel(trend: 'up' | 'down' | 'flat' | null): string {
  if (trend === 'up') {
    return 'Subiendo';
  }
  if (trend === 'down') {
    return 'Bajando';
  }
  if (trend === 'flat') {
    return 'Estable';
  }
  return 'sin tendencia';
}

export function trendIcon(trend: 'up' | 'down' | 'flat' | null): string {
  if (trend === 'up') {
    return 'trending_up';
  }
  if (trend === 'down') {
    return 'trending_down';
  }
  return 'trending_flat';
}

export function stateLabel(state: string): string {
  if (state === 'wait') {
    return 'iowait';
  }
  return state;
}

export function topStates(items: NamedSeries[], limit = 3): Array<{ name: string; value: number }> {
  return items
    .filter((item) => item.state !== 'idle')
    .map((item) => ({ name: stateLabel(item.state), value: lastPoint(item.values) }))
    .filter((item): item is { name: string; value: number } => item.value !== null)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

export function cpuBreakdown(
  items: NamedSeries[],
): Array<{ name: string; cls: string; value: number }> {
  const wanted = [
    { keys: ['user'], name: 'user', cls: 'user' },
    { keys: ['system'], name: 'system', cls: 'system' },
    { keys: ['wait', 'iowait'], name: 'iowait', cls: 'iowait' },
  ];
  return wanted
    .map((item) => {
      const found = items.find((row) => item.keys.includes(row.state));
      const value = found ? lastPoint(found.values) : null;
      return value === null ? null : { name: item.name, cls: item.cls, value };
    })
    .filter((item): item is { name: string; cls: string; value: number } => item !== null);
}

export type SparkDomain = { min: number; max: number };

export function sparkArea(
  points: SeriesPoint[],
  width = 120,
  height = 28,
  domain?: SparkDomain,
): string {
  const line = sparkPoints(points, width, height, domain);
  if (!line) {
    return '';
  }
  return `0,${height} ${line} ${width},${height}`;
}

export function barWidth(value: number | null): string {
  if (value === null) {
    return '0%';
  }
  return `${Math.max(2, Math.min(100, value * 100)).toFixed(1)}%`;
}

export function sparkPoints(
  points: SeriesPoint[],
  width = 120,
  height = 28,
  domain?: SparkDomain,
): string {
  if (points.length < 2) {
    return '';
  }
  const values = points.map(([, value]) => value);
  let min = domain?.min ?? Math.min(...values);
  let max = domain?.max ?? Math.max(...values);
  const peak = Math.max(Math.abs(min), Math.abs(max));
  const floor = Math.max(peak * 0.12, 0.02);
  if (max - min < floor) {
    const mid = (min + max) / 2;
    min = mid - floor / 2;
    max = mid + floor / 2;
  }
  const span = max - min || 1;
  const top = 2;
  const bottom = height - 2;
  return points
    .map(([, value], index) => {
      const x = (index / (points.length - 1)) * width;
      const raw = bottom - ((value - min) / span) * (bottom - top);
      const y = Math.min(bottom, Math.max(top, raw));
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function palette(): string[] {
  return [
    token('--eku-chart-series'),
    token('--eku-chart-2'),
    token('--eku-chart-3'),
    token('--eku-chart-4'),
    token('--eku-chart-5'),
    token('--eku-chart-6'),
  ];
}

export function volumeFromLines(lines: Array<{ ts: number }>): {
  points: SeriesPoint[];
  stepMs: number;
} {
  if (lines.length === 0) {
    return { points: [], stepMs: 60_000 };
  }
  const times = lines.map((item) => (item.ts > 1e12 ? item.ts : item.ts * 1000));
  const min = Math.min(...times);
  const max = Math.max(...times);
  const stepMs = Math.max(15_000, Math.round((max - min) / 24) || 60_000);
  const buckets = new Map<number, number>();
  for (const ts of times) {
    const key = Math.floor(ts / stepMs) * stepMs;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return {
    stepMs,
    points: [...buckets.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([ts, count]) => [ts / 1000, count]),
  };
}

type AxisKind = 'percent' | 'bytes' | 'bytesRate' | 'number';

export type ChartWindow = { min: number; max: number };

function axisTime(window: ChartWindow | undefined, rangeMs: number, color: string) {
  const step = timeAxisStep(rangeMs);
  const ticks = window ? timeAxisTicks(window.min, window.max) : undefined;
  return {
    axisTick: { show: true, alignWithLabel: false, customValues: ticks, lineStyle: { color } },
    axisLabel: {
      color,
      fontSize: 10,
      hideOverlap: true,
      customValues: ticks,
      formatter: (value: number) => timeAxisLabel(value, step),
    },
  };
}

export function areaOption(
  series: Array<{ name: string; points: SeriesPoint[]; color?: string }>,
  kind: AxisKind,
  stacked = false,
  window?: ChartWindow,
): EChartsOption {
  const axis = token('--eku-chart-axis');
  const grid = token('--eku-chart-grid');
  const label = token('--eku-chart-label');
  const colors = series.map((item, index) => item.color || palette()[index % palette().length]);
  return {
    color: colors,
    animationDuration: 0,
    animationDurationUpdate: 0,
    grid: {
      left: 48,
      right: 16,
      top: series.length > 1 ? 26 : 12,
      bottom: 26,
      containLabel: false,
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: token('--eku-chart-tooltip-surface'),
      borderColor: grid,
      borderWidth: 1,
      textStyle: { color: token('--eku-chart-tooltip-text'), fontSize: 11 },
      axisPointer: {
        type: 'line',
        lineStyle: { width: 1, type: 'dashed', color: axis },
      },
      valueFormatter: (value) => formatAxis(Number(value), kind),
    },
    legend:
      series.length > 1
        ? {
            top: 0,
            icon: 'rect',
            itemWidth: 8,
            itemHeight: 2,
            textStyle: { color: label, fontSize: 11 },
          }
        : undefined,
    xAxis: {
      type: 'time',
      min: window?.min,
      max: window?.max,
      ...axisTime(window, window ? window.max - window.min : 900_000, axis),
      axisLine: { lineStyle: { color: axis, width: 1 } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: kind === 'percent' ? 0 : undefined,
      max: undefined,
      scale: kind !== 'percent',
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: axis,
        fontSize: 10,
        formatter: (value: number) => formatAxis(value, kind),
      },
      splitLine: { lineStyle: { color: grid, width: 1, type: 'dashed' } },
    },
    series: series.map((item, index) => ({
      type: 'line',
      name: item.name,
      showSymbol: false,
      symbol: 'none',
      smooth: false,
      sampling: 'lttb',
      stack: stacked ? 'stack' : undefined,
      emphasis: { focus: 'series', lineStyle: { width: 1.4 } },
      areaStyle: { opacity: stacked ? 0.22 : 0.08, color: colors[index] },
      lineStyle: { width: 1, color: colors[index] },
      data: item.points.map(([ts, value]) => [ts * 1000, value]),
    })),
  };
}

export function connectionsByProtocol(
  items: NamedSeries[],
  protocol: 'tcp' | 'other',
): NamedSeries[] {
  return items
    .filter((item) => {
      const name = item.state.toLowerCase();
      const isTcp = name.startsWith('tcp');
      return protocol === 'tcp' ? isTcp : !isTcp;
    })
    .map((item) => ({
      ...item,
      state: item.state.replace(/^(tcp|udp|unix|raw)\s+/i, '') || item.state,
    }));
}

export function namedArea(
  items: NamedSeries[],
  kind: AxisKind,
  stacked = true,
  window?: ChartWindow,
): EChartsOption {
  return areaOption(
    items.map((item) => ({ name: item.state, points: item.values })),
    kind,
    stacked,
    window,
  );
}

export function diskDoughnutOption(
  usedBytes: number | null,
  totalBytes: number | null,
  usedRatio: number | null,
): EChartsOption {
  const used =
    usedBytes ?? (usedRatio !== null && totalBytes ? usedRatio * totalBytes : (usedRatio ?? 0));
  const total = totalBytes ?? (usedRatio !== null ? 1 : used);
  const free = Math.max(0, total - used);
  const ratio = total > 0 ? used / total : usedRatio;
  const fill =
    ratio !== null && ratio >= 0.9
      ? token('--eku-critical')
      : ratio !== null && ratio >= 0.8
        ? token('--eku-warning')
        : token('--eku-healthy');
  const surface = token('--eku-surface');
  return {
    animationDuration: 180,
    tooltip: {
      trigger: 'item',
      backgroundColor: token('--eku-chart-tooltip-surface'),
      borderColor: token('--eku-chart-grid'),
      textStyle: { color: token('--eku-chart-tooltip-text'), fontSize: 11 },
      formatter: '{b}: {d}%',
    },
    series: [
      {
        type: 'pie',
        name: 'Disco /',
        radius: ['58%', '78%'],
        center: ['50%', '50%'],
        padAngle: 3,
        avoidLabelOverlap: false,
        itemStyle: {
          borderRadius: 8,
          borderColor: surface,
          borderWidth: 3,
        },
        label: {
          show: true,
          position: 'center',
          formatter: () => formatPercent(ratio),
          color: token('--eku-text-primary'),
          fontSize: 18,
          fontWeight: 650,
        },
        emphasis: {
          scale: false,
          label: { show: true, fontSize: 18 },
        },
        labelLine: { show: false },
        data: [
          { value: used, name: 'Usado', itemStyle: { color: fill } },
          { value: free, name: 'Libre', itemStyle: { color: token('--eku-chart-6') } },
        ],
      },
    ],
  };
}

function formatAxis(value: number, kind: AxisKind): string {
  if (!Number.isFinite(value)) {
    return '';
  }
  if (kind === 'percent') {
    return formatPercent(value);
  }
  if (kind === 'bytesRate') {
    return formatBytesRate(value);
  }
  if (kind === 'bytes') {
    return formatSize(value);
  }
  return value.toFixed(value < 10 ? 2 : 0);
}
