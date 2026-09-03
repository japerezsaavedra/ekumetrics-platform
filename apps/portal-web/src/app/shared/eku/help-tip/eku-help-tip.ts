import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';

@Component({
  selector: 'eku-help-tip',
  imports: [MatIcon, MatTooltip],
  templateUrl: './eku-help-tip.html',
  styleUrl: './eku-help-tip.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EkuHelpTipComponent {
  readonly hint = input.required<string>();
}
