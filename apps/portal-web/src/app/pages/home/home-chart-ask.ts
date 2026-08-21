import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-home-chart-ask',
  imports: [MatIcon, MatTooltip, RouterLink],
  templateUrl: './home-chart-ask.html',
  styleUrl: './home-chart-ask.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomeChartAskComponent {
  readonly hint = input.required<string>();
  readonly question = input.required<string>();
}
