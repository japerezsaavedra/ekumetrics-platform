import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'eku-empty-state',
  templateUrl: './eku-empty-state.html',
  styleUrl: './eku-empty-state.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EkuEmptyStateComponent {
  readonly title = input('Sin datos');
  readonly message = input.required<string>();
}
