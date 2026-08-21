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
  readonly pickTime = input(false);
  readonly timePicked = output<number>();
  protected readonly zoomOn = signal(false);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly destroyRef = inject(DestroyRef);
  private chart: echarts.ECharts | null = null;
  private resize: ResizeObserver | null = null;

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
          this.chart.setOption(this.withZoom(this.option(), this.zoomOn()), { notMerge: true });
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
      queueMicrotask(sync);
      requestAnimationFrame(sync);
      this.destroyRef.onDestroy(() => {
        window.removeEventListener('resize', sync);
        this.resize?.disconnect();
        this.chart?.dispose();
        this.chart = null;
      });
    });

    effect(() => {
      const option = this.withZoom(this.option(), this.zoomOn());
      this.chart?.setOption(option, { notMerge: false, lazyUpdate: true });
    });
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
      const point = this.chart?.convertFromPixel({ seriesIndex: 0 }, [event.offsetX, event.offsetY]);
      const ts = Array.isArray(point) ? Number(point[0]) : NaN;
      if (Number.isFinite(ts)) {
        this.timePicked.emit(ts);
      }
    });
  }

  protected canZoom(): boolean {
    const dataZoom = this.option().dataZoom;
    return Array.isArray(dataZoom) ? dataZoom.length > 0 : !!dataZoom;
  }

  protected toggleZoom(): void {
    const next = !this.zoomOn();
    this.zoomOn.set(next);
    if (!next) {
      this.chart?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
    }
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
