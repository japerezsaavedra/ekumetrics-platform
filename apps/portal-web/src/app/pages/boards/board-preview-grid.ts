import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { EkuChartComponent } from '../../shared/eku/chart/eku-chart';
import { EkuEmptyStateComponent } from '../../shared/eku/empty-state/eku-empty-state';
import type { BoardHost, BoardView, BoardWidget } from './board-catalog';
import { boardChartOf, boardHostOf, boardNicOf, boardRateOf, boardValueOf } from './board-widget-view';

@Component({
  selector: 'app-board-preview-grid',
  imports: [EkuChartComponent, EkuEmptyStateComponent],
  templateUrl: './board-preview-grid.html',
  styleUrl: './board-preview-grid.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardPreviewGrid {
  readonly widgets = input<BoardWidget[]>([]);
  readonly hosts = input<BoardHost[]>([]);
  readonly nics = input<BoardView['nics']>([]);
  readonly series = input<BoardView['series']>({});
  readonly emptyMessage = input('Agregue componentes para ver cómo quedará la pantalla.');

  protected hostOf(widget: BoardWidget): BoardHost | null {
    return boardHostOf(widget, this.hosts());
  }

  protected valueOf(widget: BoardWidget): string {
    return boardValueOf(widget, this.hostOf(widget));
  }

  protected nicOf(widget: BoardWidget) {
    return boardNicOf(widget, this.hostOf(widget), this.nics());
  }

  protected chartOf(widget: BoardWidget) {
    return boardChartOf(widget, this.hostOf(widget), this.series());
  }

  protected rateOf(value: number | null | undefined): string {
    return boardRateOf(value);
  }
}
