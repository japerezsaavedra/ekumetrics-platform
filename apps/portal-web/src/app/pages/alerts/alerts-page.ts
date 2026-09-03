import { HttpClient } from '@angular/common/http';
import { KeyValuePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { startWith } from 'rxjs';
import { MatIcon } from '@angular/material/icon';
import { timer } from 'rxjs';
import { API_BASE_URL } from '../../core/api';
import { TenantService } from '../../core/tenant';
import { EkuEmptyStateComponent } from '../../shared/eku/empty-state/eku-empty-state';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuLoadingSkeletonComponent } from '../../shared/eku/loading-skeleton/eku-loading-skeleton';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';

type AlertMatcher = {
  name: string;
  value: string;
  isRegex: boolean;
  isEqual: boolean;
};

type ManagedAlert = {
  annotations: Record<string, string>;
  endsAt: string | null;
  fingerprint: string;
  generatorUrl: string;
  inhibitedBy: string[];
  labels: Record<string, string>;
  name: string;
  severity: string;
  silencedBy: string[];
  startsAt: string | null;
  state: string;
  updatedAt: string | null;
};

type ManagedSilence = {
  comment: string;
  createdBy: string;
  endsAt: string | null;
  id: string;
  matchers: AlertMatcher[];
  startsAt: string | null;
  status: string;
  updatedAt: string | null;
};

type AlertmanagerOverview = {
  alerts: ManagedAlert[];
  silences: ManagedSilence[];
  updatedAt: string;
};

const MATCHER_PRIORITY = [
  'alertname',
  'tenant_id',
  'tenant',
  'site_id',
  'site',
  'instance',
  'job',
  'service',
];

@Component({
  selector: 'app-alerts-page',
  imports: [
    ReactiveFormsModule,
    KeyValuePipe,
    MatIcon,
    EkuEmptyStateComponent,
    EkuErrorStateComponent,
    EkuLoadingSkeletonComponent,
    EkuPageHeaderComponent,
  ],
  templateUrl: './alerts-page.html',
  styleUrl: './alerts-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertsPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly tenants = inject(TenantService);

  protected readonly overview = signal<AlertmanagerOverview | null>(null);
  protected readonly loading = signal(true);
  protected readonly refreshing = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly severityControl = new FormControl<
    'all' | 'critical' | 'warning' | 'info' | 'unknown' | 'silenced'
  >('all', { nonNullable: true });
  private readonly severity = toSignal(
    this.severityControl.valueChanges.pipe(startWith(this.severityControl.value)),
    {
      initialValue: this.severityControl.value,
    },
  );
  protected readonly selectedAlert = signal<ManagedAlert | null>(null);
  protected readonly silenceForm = this.fb.nonNullable.group({
    durationMinutes: [60, [Validators.required, Validators.min(5), Validators.max(10_080)]],
    comment: ['', [Validators.required, Validators.minLength(5), Validators.maxLength(500)]],
  });

  protected readonly alerts = computed(() => {
    const rank: Record<string, number> = { critical: 0, warning: 1, info: 2, unknown: 3 };
    return [...(this.overview()?.alerts ?? [])].sort((left, right) => {
      const severity = (rank[left.severity] ?? 4) - (rank[right.severity] ?? 4);
      return severity || Date.parse(left.startsAt ?? '') - Date.parse(right.startsAt ?? '');
    });
  });
  protected readonly visibleAlerts = computed(() => {
    const severity = this.severity();
    if (severity === 'all') {
      return this.alerts();
    }
    if (severity === 'silenced') {
      return this.alerts().filter((alert) => alert.silencedBy.length > 0);
    }
    return this.alerts().filter((alert) => alert.severity === severity);
  });
  protected readonly inventoryHint = computed(() => {
    const updated = this.formatDate(this.overview()?.updatedAt ?? null);
    const tenant = this.tenants.current()?.name || this.tenants.slug() || 'tenant';
    return `${tenant}: ${this.alerts().length} activas · ${this.activeSilences().length} silencios · ${updated}`;
  });
  protected readonly activeSilences = computed(() =>
    (this.overview()?.silences ?? [])
      .filter((silence) => silence.status === 'active' || silence.status === 'pending')
      .sort((left, right) => Date.parse(left.endsAt ?? '') - Date.parse(right.endsAt ?? '')),
  );
  protected readonly criticalCount = computed(
    () => this.alerts().filter((alert) => alert.severity === 'critical').length,
  );
  protected readonly warningCount = computed(
    () => this.alerts().filter((alert) => alert.severity === 'warning').length,
  );
  protected readonly silencedCount = computed(
    () => this.alerts().filter((alert) => alert.silencedBy.length > 0).length,
  );
  protected readonly selectedMatchers = computed(() => {
    const labels = this.selectedAlert()?.labels ?? {};
    return MATCHER_PRIORITY.filter((name) => labels[name])
      .slice(0, 6)
      .map((name) => ({
        name,
        value: labels[name],
        isRegex: false,
        isEqual: true,
      }));
  });

  constructor() {
    effect(() => {
      this.tenants.slug();
      untracked(() => this.load(false));
    });
    timer(30_000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.load(false));
  }

  protected refresh(): void {
    this.load(true);
  }

  protected setSeverity(
    value: 'all' | 'critical' | 'warning' | 'info' | 'unknown' | 'silenced',
  ): void {
    this.severityControl.setValue(value);
  }

  protected openSilence(alert: ManagedAlert): void {
    this.selectedAlert.set(alert);
    this.error.set(null);
    this.silenceForm.reset({ durationMinutes: 60, comment: '' });
  }

  protected closeSilence(): void {
    this.selectedAlert.set(null);
  }

  protected createSilence(): void {
    if (this.silenceForm.invalid || this.selectedMatchers().length === 0) {
      this.silenceForm.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    const value = this.silenceForm.getRawValue();
    this.http
      .post(`${API_BASE_URL}/v1/alerts/silences`, {
        durationMinutes: Number(value.durationMinutes),
        comment: value.comment,
        matchers: this.selectedMatchers(),
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.selectedAlert.set(null);
          this.load(false);
        },
        error: (error: { error?: { message?: string } }) => {
          this.saving.set(false);
          this.error.set(error.error?.message ?? 'No se pudo crear el silencio.');
        },
      });
  }

  protected expireSilence(silence: ManagedSilence): void {
    if (!window.confirm(`¿Finalizar ahora el silencio “${silence.comment}”?`)) return;
    this.error.set(null);
    this.http
      .delete(`${API_BASE_URL}/v1/alerts/silences/${encodeURIComponent(silence.id)}`)
      .subscribe({
        next: () => this.load(false),
        error: (error: { error?: { message?: string } }) => {
          this.error.set(error.error?.message ?? 'No se pudo finalizar el silencio.');
        },
      });
  }

  protected summary(alert: ManagedAlert): string {
    return alert.annotations['summary'] || alert.annotations['description'] || 'Sin descripción.';
  }

  protected impact(alert: ManagedAlert): string {
    return alert.annotations['impact'] || '';
  }

  protected formatDate(value: string | null): string {
    if (!value) return 'Sin fecha';
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? 'Fecha inválida'
      : new Intl.DateTimeFormat('es-CL', {
          dateStyle: 'short',
          timeStyle: 'medium',
        }).format(date);
  }

  protected matcherLabel(matchers: AlertMatcher[]): string {
    return matchers
      .map((matcher) => `${matcher.name}${matcher.isEqual ? '=' : '!='}${matcher.value}`)
      .join(' · ');
  }

  protected severityLabel(value: string): string {
    return (
      { critical: 'Crítica', warning: 'Advertencia', info: 'Informativa' }[value] ??
      'Sin clasificar'
    );
  }

  protected silenceStatus(value: string): string {
    return { active: 'Vigente', pending: 'Pendiente', expired: 'Vencido' }[value] ?? value;
  }

  private load(manual: boolean): void {
    if (manual) this.refreshing.set(true);
    this.http.get<AlertmanagerOverview>(`${API_BASE_URL}/v1/alerts`).subscribe({
      next: (overview) => {
        this.overview.set(overview);
        this.loading.set(false);
        this.refreshing.set(false);
        this.error.set(null);
      },
      error: (error: { error?: { message?: string } }) => {
        this.loading.set(false);
        this.refreshing.set(false);
        this.error.set(error.error?.message ?? 'No se pudo consultar el servicio de alertas.');
      },
    });
  }
}
