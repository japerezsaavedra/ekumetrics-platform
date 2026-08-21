import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'eku-error-state',
  templateUrl: './eku-error-state.html',
  styleUrl: './eku-error-state.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EkuErrorStateComponent {
  readonly message = input.required<string>();
}
