import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { timer } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { API_BASE_URL } from '../../core/api';
import { KioskService } from '../../core/kiosk';
import { TenantService } from '../../core/tenant';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';
import { BoardPreviewGrid } from './board-preview-grid';
import type { BoardView } from './board-catalog';

@Component({
  selector: 'app-board-view-page',
  imports: [RouterLink, EkuErrorStateComponent, EkuPageHeaderComponent, BoardPreviewGrid],
  templateUrl: './board-view-page.html',
  styleUrl: './board-view-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardViewPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly tenants = inject(TenantService);
  private readonly kiosk = inject(KioskService);

  protected readonly view = signal<BoardView | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly boardId =
    this.route.snapshot.paramMap.get('id') ?? this.route.snapshot.paramMap.get('dashboard') ?? '';
  protected readonly kioskOn = this.kiosk.active;
  protected readonly widgets = computed(() => this.view()?.board.widgets ?? []);

  constructor() {
    this.tenants.load();
    timer(0, 30_000)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.reload());
  }

  private reload(): void {
    this.http
      .get<BoardView>(`${API_BASE_URL}/v1/boards/${this.boardId}/view`, {
        params: { tenant: this.tenants.slug() },
      })
      .subscribe({
        next: (data) => {
          this.view.set(data);
          this.error.set(null);
        },
        error: (err: { error?: { message?: string } }) =>
          this.error.set(err.error?.message ?? 'No se pudo cargar el dashboard.'),
      });
  }
}
