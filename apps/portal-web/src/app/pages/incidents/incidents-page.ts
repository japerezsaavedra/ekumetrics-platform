import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { API_BASE_URL } from '../../core/api';
import { TenantService } from '../../core/tenant';
import { EkuEmptyStateComponent } from '../../shared/eku/empty-state/eku-empty-state';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuLoadingSkeletonComponent } from '../../shared/eku/loading-skeleton/eku-loading-skeleton';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';
import { IncidentEnrichmentPanel } from './incident-enrichment-panel';
import {
  enrichmentPriority,
  type IncidentEnrichmentDto,
} from './incident-enrichment.view';

type IncidentMember = {
  alerts?: { fingerprint: string; name: string; severity: string }[];
  impact?: string[];
};

type ManagedIncident = {
  id: string;
  title: string;
  status: string;
  severity: string;
  siteId: string | null;
  causeName: string | null;
  causeKey: string | null;
  confidence: number | null;
  alertCount: number;
  eventCount: number;
  windowStart: string | null;
  windowEnd: string | null;
  members: IncidentMember | null;
  enrichment?: IncidentEnrichmentDto | null;
  createdAt: string;
  updatedAt: string;
};

@Component({
  selector: 'app-incidents-page',
  imports: [
    DatePipe,
    EkuEmptyStateComponent,
    EkuErrorStateComponent,
    EkuLoadingSkeletonComponent,
    EkuPageHeaderComponent,
    IncidentEnrichmentPanel,
  ],
  templateUrl: './incidents-page.html',
  styleUrl: './incidents-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IncidentsPage {
  private readonly http = inject(HttpClient);
  private readonly tenants = inject(TenantService);

  protected readonly loading = signal(true);
  protected readonly correlating = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly items = signal<ManagedIncident[]>([]);
  protected readonly selectedId = signal<string | null>(null);

  protected readonly selected = computed(
    () => this.items().find((item) => item.id === this.selectedId()) ?? null,
  );
  protected readonly openCount = computed(
    () => this.items().filter((item) => item.status === 'open' || item.status === 'acknowledged').length,
  );

  constructor() {
    effect(() => {
      this.tenants.slug();
      untracked(() => this.load());
    });
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.http.get<ManagedIncident[]>(`${API_BASE_URL}/v1/incidents`).subscribe({
      next: (rows) => {
        this.items.set(rows);
        if (!rows.some((row) => row.id === this.selectedId())) {
          this.selectedId.set(rows[0]?.id ?? null);
        }
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.message ?? 'No se pudieron cargar los incidentes.');
        this.loading.set(false);
      },
    });
  }

  protected correlate(): void {
    this.correlating.set(true);
    this.error.set(null);
    this.http
      .post<{ created: number; updated: number }>(`${API_BASE_URL}/v1/incidents/correlate`, {})
      .subscribe({
        next: () => {
          this.correlating.set(false);
          this.load();
        },
        error: (err) => {
          this.error.set(err.error?.message ?? 'No se pudo correlacionar.');
          this.correlating.set(false);
        },
      });
  }

  protected select(item: ManagedIncident): void {
    this.selectedId.set(item.id);
  }

  protected confidence(value: number | null): string {
    if (value == null) return 'Sin causa en el grafo';
    return `${Math.round(value * 100)} %`;
  }

  protected priorityOf(item: ManagedIncident): string | null {
    return enrichmentPriority(item.enrichment);
  }

  protected onEnrichmentFeedback(row: IncidentEnrichmentDto): void {
    this.items.update((current) =>
      current.map((item) =>
        item.id === this.selectedId() ? { ...item, enrichment: row } : item,
      ),
    );
  }
}
