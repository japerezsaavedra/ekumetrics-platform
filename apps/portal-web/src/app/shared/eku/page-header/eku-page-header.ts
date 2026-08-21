import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'eku-page-header',
  templateUrl: './eku-page-header.html',
  styleUrl: './eku-page-header.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EkuPageHeaderComponent {
  readonly title = input.required<string>();
  readonly subtitle = input<string>();
}
