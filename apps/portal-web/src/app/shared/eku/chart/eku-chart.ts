import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import { timeAxisLabel, timeAxisStep, timeAxisTicks } from './time-axis';

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

const LOCK_AFTER_MS = 30_000;

@Component({
  selector: 'eku-chart',
  templateUrl: './eku-chart.html',
  styleUrl: './eku-chart.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.eku-chart--pick]': 'pickTime()',
  },
})
export class EkuChartComponent {
  readonly option = input.required<EChartsOption>();
  readonly rangeMs = input<number | null>(null);
  readonly stripKey = input('');
  readonly pickTime = input(false);
  readonly timePicked = output<number>();
  protected readonly zoomOn = signal(false);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly destroyRef = inject(DestroyRef);
  private chart: echarts.ECharts | null = null;
  private resize: ResizeObserver | null = null;
  private readonly buffers = new Map<string, Map<number, number>>();
  private lastKey = '';
  private lastRangeMs: number | null = null;
  private bufferRangeMs: number | null = null;
  private timer = 0;

  constructor() {
    afterNextRender(() => {
      const el = this.host().nativeElement;
      const sync = () => {
        const width = el.clientWidth;
        const height = el.clientHeight;
        if (width < 8 || height < 8) {
          return;
        }
        if (!this.chart) {
          this.chart = echarts.init(el);
          this.paint(true);
          this.bindTimePick();
          return;
        }
        this.chart.resize();
      };
      this.resize = new ResizeObserver(sync);
      this.resize.observe(el);
      if (el.parentElement) {
        this.resize.observe(el.parentElement);
      }
      window.addEventListener('resize', sync);
      this.timer = window.setInterval(() => this.paint(false), 1000);
      queueMicrotask(sync);
      requestAnimationFrame(sync);
      this.destroyRef.onDestroy(() => {
        window.removeEventListener('resize', sync);
        this.resize?.disconnect();
        window.clearInterval(this.timer);
        this.chart?.dispose();
        this.chart = null;
      });
    });

    effect(() => {
      const key = this.stripKey();
      const rangeMs = this.rangeMs();
      this.option();
      if (key !== this.lastKey || rangeMs !== this.bufferRangeMs) {
        this.buffers.clear();
        this.lastKey = key;
        this.bufferRangeMs = rangeMs;
      }
      this.mergeBuffers(untracked(() => this.option()));
      this.paint(false);
    });
  }

  private now(): number {
    return Date.now();
  }

  private mergeBuffers(option: EChartsOption): void {
    const series = option.series;
    if (!Array.isArray(series)) {
      return;
    }
    const now = this.now();
    const rangeMs = this.rangeMs() ?? 0;
    const dropBefore = now - rangeMs - 60_000;
    for (const item of series) {
      if (!item || typeof item !== 'object' || !('data' in item) || !Array.isArray(item.data)) {
        continue;
      }
      const name = String('name' in item && item.name != null ? item.name : 'series');
      let buffer = this.buffers.get(name);
      if (!buffer) {
        buffer = new Map();
        this.buffers.set(name, buffer);
      }
      for (const point of item.data) {
        if (!Array.isArray(point) || point.length < 2) {
          continue;
        }
        const ts = Number(point[0]);
        const value = Number(point[1]);
        if (!Number.isFinite(ts) || !Number.isFinite(value)) {
          continue;
        }
        const previous = buffer.get(ts);
        if (previous !== undefined && now - ts > LOCK_AFTER_MS) {
          continue;
        }
        buffer.set(ts, value);
      }
      for (const ts of buffer.keys()) {
        if (ts < dropBefore) {
          buffer.delete(ts);
        }
      }
    }
  }

  private paint(first: boolean): void {
    if (!this.chart) {
      return;
    }
    const option = this.option();
    const rangeMs = this.rangeMs();
    const reset = first || rangeMs !== this.lastRangeMs;
    this.lastRangeMs = rangeMs;
    if (rangeMs === null) {
      this.chart.setOption(this.withZoom(option, this.zoomOn()), {
        notMerge: reset,
        lazyUpdate: false,
      });
      return;
    }
    const live = this.withLive(option);
    if (reset) {
      this.chart.setOption(live, { notMerge: true, lazyUpdate: false });
      return;
    }
    this.chart.setOption(live, { lazyUpdate: false, replaceMerge: ['dataZoom'] });
  }

  private withLive(option: EChartsOption): EChartsOption {
    const source = Array.isArray(option.series) ? option.series : [];
    const rangeMs = this.rangeMs() ?? 900_000;
    const now = this.now();
    const min = now - rangeMs;
    const step = timeAxisStep(rangeMs);
    const ticks = timeAxisTicks(min, now);
    const live = {
      ...option,
      animation: false,
      animationDuration: 0,
      animationDurationUpdate: 0,
      dataZoom: [],
      xAxis: {
        type: 'time' as const,
        min,
        max: now,
        axisTick: { show: true, alignWithLabel: false, customValues: ticks },
        axisLabel: {
          hideOverlap: true,
          customValues: ticks,
          formatter: (value: number) => timeAxisLabel(value, step),
          fontSize: 10,
        },
      },
      series: source.map((item) => {
        const base = item && typeof item === 'object' ? item : {};
        const name = String('name' in base && base.name != null ? base.name : 'series');
        const buffer = this.buffers.get(name);
        const data = buffer
          ? [...buffer.entries()]
              .sort((left, right) => left[0] - right[0])
              .map(([ts, value]) => ({ id: String(ts), value: [ts, value] as [number, number] }))
          : [];
        const last = data[data.length - 1];
        if (last && last.value[0] < now) {
          data.push({ id: `${name}-live`, value: [now, last.value[1]] });
        }
        return {
          type: 'line' as const,
          name,
          id: name,
          showSymbol: false,
          symbol: 'none',
          smooth: false,
          connectNulls: true,
          areaStyle: 'areaStyle' in base ? (base as { areaStyle?: object }).areaStyle : undefined,
          lineStyle: 'lineStyle' in base ? (base as { lineStyle?: object }).lineStyle : undefined,
          stack: 'stack' in base ? (base as { stack?: string }).stack : undefined,
          data,
        };
      }),
    };
    return live as EChartsOption;
  }

  private bindTimePick(): void {
    if (!this.pickTime() || !this.chart) {
      return;
    }
    let last = 0;
    this.chart.getZr().on('click', (event: { offsetX: number; offsetY: number }) => {
      const now = Date.now();
      if (now - last < 250) {
        return;
      }
      last = now;
      const point = this.chart?.convertFromPixel({ seriesIndex: 0 }, [
        event.offsetX,
        event.offsetY,
      ]);
      const ts = Array.isArray(point) ? Number(point[0]) : NaN;
      if (Number.isFinite(ts)) {
        this.timePicked.emit(ts);
      }
    });
  }

  protected canZoom(): boolean {
    return this.rangeMs() === null && !!this.option().dataZoom;
  }

  protected toggleZoom(): void {
    this.zoomOn.set(!this.zoomOn());
  }

  private withZoom(option: EChartsOption, zoomOn: boolean): EChartsOption {
    const dataZoom = option.dataZoom;
    if (!dataZoom) {
      return option;
    }
    const items = Array.isArray(dataZoom) ? dataZoom : [dataZoom];
    return {
      ...option,
      dataZoom: items.map((item) => ({
        ...item,
        disabled: !zoomOn,
        zoomOnMouseWheel: zoomOn,
        moveOnMouseWheel: false,
        moveOnMouseMove: zoomOn,
      })),
    };
  }
}
