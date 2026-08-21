import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'eku-loading-skeleton',
  templateUrl: './eku-loading-skeleton.html',
  styleUrl: './eku-loading-skeleton.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EkuLoadingSkeletonComponent {
  readonly label = input('Cargando');
  readonly bars = input(3);
  readonly barsArray = computed(() => Array.from({ length: this.bars() }));
}
