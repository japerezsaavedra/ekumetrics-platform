import {
  CdkDrag,
  CdkDragHandle,
  CdkDragPlaceholder,
  CdkDragPreview,
  CdkDropList,
} from '@angular/cdk/drag-drop';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormArray, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatTab, MatTabGroup } from '@angular/material/tabs';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_BASE_URL } from '../../core/api';
import { TenantService } from '../../core/tenant';
import { EkuChartComponent } from '../../shared/eku/chart/eku-chart';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';
import {
  BOARD_WIDGET_CATALOG,
  type BoardHost,
  type BoardRecord,
  type BoardSite,
  type BoardView,
  type BoardWidget,
  type BoardWidgetType,
} from './board-catalog';
import { BoardPreviewGrid } from './board-preview-grid';
import { boardChartOf, boardHostOf, boardNicOf, boardRateOf, boardValueOf } from './board-widget-view';

@Component({
  selector: 'app-board-editor-page',
  imports: [
    CdkDrag,
    CdkDragHandle,
    CdkDragPlaceholder,
    CdkDragPreview,
    CdkDropList,
    ReactiveFormsModule,
    RouterLink,
    MatTab,
    MatTabGroup,
    EkuChartComponent,
    EkuErrorStateComponent,
    EkuPageHeaderComponent,
    BoardPreviewGrid,
  ],
  templateUrl: './board-editor-page.html',
  styleUrl: './board-editor-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardEditorPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly tenants = inject(TenantService);

  protected readonly catalog = BOARD_WIDGET_CATALOG;
  protected readonly hosts = signal<BoardHost[]>([]);
  protected readonly sites = signal<BoardSite[]>([]);
  protected readonly preview = signal<BoardView | null>(null);
  protected readonly draftWidgets = signal<BoardWidget[]>([]);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly scopeKind = signal<'tenant' | 'site'>('tenant');
  protected readonly scopeSiteId = signal('');
  protected readonly tab = signal(0);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly removing = signal(false);
  protected readonly boardId = this.route.snapshot.paramMap.get('id') ?? '';
  protected readonly widths = [3, 4, 6, 12];
  protected readonly heights = [1, 2];
  protected readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2)]],
    scope: this.fb.nonNullable.control<'tenant' | 'site'>('tenant'),
    siteId: [''],
    widgets: this.fb.nonNullable.array<ReturnType<BoardEditorPage['widgetGroup']>>([]),
  });
  protected readonly scopedHosts = computed(() => {
    if (this.scopeKind() !== 'site') return this.hosts();
    const site = this.sites().find((item) => item.id === this.scopeSiteId());
    if (!site) return [];
    return this.hosts().filter((host) => host.siteId === site.slug);
  });
  protected readonly scopedNics = computed(() => {
    const ids = new Set(this.scopedHosts().map((host) => host.id));
    return (this.preview()?.nics ?? []).filter((nic) => ids.has(nic.hostId));
  });

  constructor() {
    this.tenants.load();
    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.syncDraft());
    this.form.controls.scope.valueChanges.pipe(takeUntilDestroyed()).subscribe((scope) => {
      if (scope === 'site') {
        this.form.controls.siteId.setValidators([Validators.required]);
      } else {
        this.form.controls.siteId.clearValidators();
        this.form.controls.siteId.setValue('');
      }
      this.form.controls.siteId.updateValueAndValidity({ emitEvent: false });
      this.applyScope();
    });
    this.form.controls.siteId.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.applyScope());
    this.reload();
  }

  protected get widgets(): FormArray<ReturnType<BoardEditorPage['widgetGroup']>> {
    return this.form.controls.widgets;
  }

  protected selectedGroup(): ReturnType<BoardEditorPage['widgetGroup']> | null {
    const id = this.selectedId();
    return this.widgets.controls.find((item) => item.controls.id.value === id) ?? null;
  }

  protected asWidget(group: ReturnType<BoardEditorPage['widgetGroup']>): BoardWidget {
    return group.getRawValue();
  }

  protected hostOf(widget: BoardWidget): BoardHost | null {
    return boardHostOf(widget, this.scopedHosts());
  }

  protected hostLabel(host: BoardHost): string {
    const site = this.sites().find((item) => item.slug === host.siteId);
    return this.scopeKind() === 'tenant' && site ? `${host.id} · ${site.name}` : host.id;
  }

  protected valueOf(widget: BoardWidget): string {
    return boardValueOf(widget, this.hostOf(widget));
  }

  protected nicOf(widget: BoardWidget) {
    return boardNicOf(widget, this.hostOf(widget), this.preview()?.nics ?? []);
  }

  protected chartOf(widget: BoardWidget) {
    return boardChartOf(widget, this.hostOf(widget), this.preview()?.series ?? {});
  }

  protected rateOf(value: number | null | undefined): string {
    return boardRateOf(value);
  }

  protected select(id: string): void {
    this.selectedId.set(id);
  }

  protected addWidget(type: BoardWidgetType, index = this.widgets.length): void {
    const item = this.catalog.find((row) => row.type === type);
    if (!item) return;
    const group = this.widgetGroup({
      id: crypto.randomUUID(),
      type: item.type,
      title: item.title,
        agentId: this.scopedHosts()[0]?.id ?? '',
      w: item.w,
      h: item.h,
    });
    this.widgets.insert(index, group);
    this.selectedId.set(group.controls.id.value);
  }

  protected removeSelected(): void {
    const id = this.selectedId();
    const index = this.widgets.controls.findIndex((item) => item.controls.id.value === id);
    if (index < 0) return;
    this.widgets.removeAt(index);
    this.selectedId.set(this.widgets.at(Math.min(index, this.widgets.length - 1))?.controls.id.value ?? null);
  }

  protected drop(event: {
    previousContainer: { id: string };
    previousIndex: number;
    currentIndex: number;
    item: { data: { type?: BoardWidgetType } | number };
  }): void {
    if (event.previousContainer.id === 'board-catalog') {
      const item = event.item.data as { type: BoardWidgetType };
      this.addWidget(item.type, event.currentIndex);
      return;
    }
    if (event.previousIndex === event.currentIndex) return;
    const control = this.widgets.at(event.previousIndex);
    this.widgets.removeAt(event.previousIndex);
    this.widgets.insert(event.currentIndex, control);
    this.selectedId.set(control.controls.id.value);
  }

  protected save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    this.saving.set(true);
    this.http
      .patch<BoardRecord>(`${API_BASE_URL}/v1/boards/${this.boardId}`, {
        name: value.name,
        siteId: value.scope === 'site' ? value.siteId : null,
        widgets: value.widgets,
        tenant: this.tenants.slug(),
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.error.set(null);
        },
        error: (err: { error?: { message?: string } }) => {
          this.saving.set(false);
          this.error.set(err.error?.message ?? 'No se pudo guardar el dashboard.');
        },
      });
  }

  protected removeBoard(): void {
    const name = this.form.controls.name.value || 'este dashboard';
    if (!window.confirm(`¿Eliminar el dashboard ${name}?`)) {
      return;
    }
    this.removing.set(true);
    this.http
      .delete(`${API_BASE_URL}/v1/boards/${this.boardId}`, {
        params: { tenant: this.tenants.slug() },
      })
      .subscribe({
        next: () => this.router.navigate(['/dashboards']),
        error: (err: { error?: { message?: string } }) => {
          this.removing.set(false);
          this.error.set(err.error?.message ?? 'No se pudo eliminar el dashboard.');
        },
      });
  }

  private syncDraft(): void {
    this.draftWidgets.set(this.form.getRawValue().widgets);
  }

  private applyScope(): void {
    this.scopeKind.set(this.form.controls.scope.value);
    this.scopeSiteId.set(this.form.controls.siteId.value);
    const allowed = new Set(this.scopedHosts().map((host) => host.id));
    for (const widget of this.widgets.controls) {
      const agentId = widget.controls.agentId.value;
      if (agentId && !allowed.has(agentId)) {
        widget.controls.agentId.setValue(this.scopedHosts()[0]?.id ?? '', { emitEvent: false });
      }
    }
    this.syncDraft();
  }

  private widgetGroup(item: {
    id: string;
    type: BoardWidgetType;
    title: string;
    agentId: string;
    w: number;
    h: number;
  }) {
    return this.fb.nonNullable.group({
      id: [item.id, Validators.required],
      type: [item.type, Validators.required],
      title: [item.title, [Validators.required, Validators.minLength(1)]],
      agentId: [item.agentId],
      w: [item.w, [Validators.required, Validators.min(3), Validators.max(12)]],
      h: [item.h, [Validators.required, Validators.min(1), Validators.max(2)]],
    });
  }

  private reload(): void {
    const tenant = this.tenants.slug();
    this.http
      .get<BoardRecord>(`${API_BASE_URL}/v1/boards/${this.boardId}`, { params: { tenant } })
      .subscribe({
        next: (board) => {
          this.form.patchValue({
            name: board.name,
            scope: board.siteId ? 'site' : 'tenant',
            siteId: board.siteId ?? '',
          });
          this.widgets.clear();
          for (const widget of board.widgets ?? []) {
            this.widgets.push(this.widgetGroup(widget));
          }
          this.applyScope();
          this.selectedId.set(this.widgets.at(0)?.controls.id.value ?? null);
        },
        error: () => this.router.navigate(['/dashboards']),
      });
    this.http
      .get<BoardView>(`${API_BASE_URL}/v1/boards/${this.boardId}/view`, { params: { tenant } })
      .subscribe({
        next: (data) => {
          this.preview.set(data);
          if (this.hosts().length === 0) {
            this.hosts.set(data.hosts ?? []);
          }
        },
      });
    this.loadHosts(tenant);
    this.http
      .get<BoardSite[]>(`${API_BASE_URL}/v1/tenants/${tenant}/sites`, { params: { as: tenant } })
      .subscribe({
        next: (rows) => this.sites.set(rows),
      });
  }

  private loadHosts(tenant: string): void {
    this.http
      .get<{ hosts?: BoardHost[]; nics?: BoardView['nics'] }>(`${API_BASE_URL}/v1/dashboard`, {
        params: { tenant_id: tenant, view: 'hosts' },
      })
      .subscribe({
        next: (data) => {
          this.hosts.set(data.hosts ?? []);
          this.preview.update((current) =>
            current
              ? { ...current, hosts: data.hosts ?? current.hosts, nics: data.nics ?? current.nics }
              : current,
          );
          this.applyScope();
        },
      });
  }
}
