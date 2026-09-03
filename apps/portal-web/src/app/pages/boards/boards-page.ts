import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { API_BASE_URL } from '../../core/api';
import { TenantService } from '../../core/tenant';
import { EkuEmptyStateComponent } from '../../shared/eku/empty-state/eku-empty-state';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';
import { boardScopeLabel, type BoardRecord, type BoardSite } from './board-catalog';

@Component({
  selector: 'app-boards-page',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    EkuEmptyStateComponent,
    EkuErrorStateComponent,
    EkuPageHeaderComponent,
  ],
  templateUrl: './boards-page.html',
  styleUrl: './boards-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardsPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly tenants = inject(TenantService);

  protected readonly items = signal<BoardRecord[]>([]);
  protected readonly sites = signal<BoardSite[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly creating = signal(false);
  protected readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2)]],
    scope: this.fb.nonNullable.control<'tenant' | 'site'>('tenant'),
    siteId: [''],
  });

  constructor() {
    this.tenants.load();
    effect(() => {
      this.tenants.slug();
      untracked(() => this.reload());
    });
    this.form.controls.scope.valueChanges.subscribe((scope) => {
      if (scope === 'site') {
        this.form.controls.siteId.setValidators([Validators.required]);
      } else {
        this.form.controls.siteId.clearValidators();
        this.form.controls.siteId.setValue('');
      }
      this.form.controls.siteId.updateValueAndValidity({ emitEvent: false });
    });
  }

  protected scopeLabel(item: BoardRecord): string {
    return boardScopeLabel(item);
  }

  protected toggleCreate(): void {
    this.creating.update((open) => !open);
    this.form.reset({ name: '', scope: 'tenant', siteId: '' });
    this.form.controls.siteId.clearValidators();
    this.form.controls.siteId.updateValueAndValidity({ emitEvent: false });
    this.error.set(null);
  }

  protected create(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.http
      .post<BoardRecord>(`${API_BASE_URL}/v1/boards`, {
        name: this.form.controls.name.value,
        siteId: this.form.controls.scope.value === 'site' ? this.form.controls.siteId.value : null,
        tenant: this.tenants.slug(),
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.creating.set(false);
          this.form.reset({ name: '', scope: 'tenant', siteId: '' });
          this.reload();
        },
        error: (err: { error?: { message?: string } }) => {
          this.saving.set(false);
          this.error.set(err.error?.message ?? 'No se pudo crear el dashboard.');
        },
      });
  }

  protected remove(item: BoardRecord): void {
    if (!window.confirm(`¿Eliminar el dashboard ${item.name}?`)) {
      return;
    }
    this.http
      .delete(`${API_BASE_URL}/v1/boards/${item.id}`, {
        params: { tenant: this.tenants.slug() },
      })
      .subscribe({
        next: () => this.reload(),
        error: (err: { error?: { message?: string } }) =>
          this.error.set(err.error?.message ?? 'No se pudo eliminar el dashboard.'),
      });
  }

  private reload(): void {
    this.http
      .get<BoardRecord[]>(`${API_BASE_URL}/v1/boards`, {
        params: { tenant: this.tenants.slug() },
      })
      .subscribe({
        next: (rows) => this.items.set(rows),
        error: (err: { error?: { message?: string } }) =>
          this.error.set(err.error?.message ?? 'No se pudieron cargar los dashboards.'),
      });
    const slug = this.tenants.slug();
    this.http.get<BoardSite[]>(`${API_BASE_URL}/v1/tenants/${slug}/sites`, { params: { as: slug } }).subscribe({
      next: (rows) => this.sites.set(rows),
    });
  }
}
