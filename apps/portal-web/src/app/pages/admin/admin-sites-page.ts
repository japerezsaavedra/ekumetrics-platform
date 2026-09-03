import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { API_BASE_URL } from '../../core/api';
import { TenantService } from '../../core/tenant';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';

type TenantSite = {
  id: string;
  slug: string;
  name: string;
  agentCount?: number;
};

type EnrolledAgent = {
  id: string;
  agentId: string;
  siteId: string;
  mode: string;
  yaml: string;
};

type BoardOption = {
  id: string;
  name: string;
  site?: { id: string; slug: string; name: string } | null;
};

type KioskDevice = {
  id: string;
  name: string;
  tenant: string;
  site: string;
  dashboard: string;
  credentialExpiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  secret?: string;
};

@Component({
  selector: 'app-admin-sites-page',
  imports: [
    ReactiveFormsModule,
    MatIcon,
    MatTooltip,
    EkuPageHeaderComponent,
    EkuErrorStateComponent,
  ],
  templateUrl: './admin-sites-page.html',
  styleUrl: './admin-sites-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminSitesPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly tenants = inject(TenantService);

  protected readonly tenantSlug = this.tenants.slug;
  protected readonly items = signal<TenantSite[]>([]);
  protected readonly agents = signal<EnrolledAgent[]>([]);
  protected readonly siteOpen = signal(false);
  protected readonly agentOpen = signal(false);
  protected readonly editingSiteId = signal<string | null>(null);
  protected readonly editingAgentId = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly enrolled = signal<EnrolledAgent | null>(null);
  protected readonly kiosks = signal<KioskDevice[]>([]);
  protected readonly boards = signal<BoardOption[]>([]);
  protected readonly kioskOpen = signal(false);
  protected readonly kioskCredential = signal<KioskDevice | null>(null);
  protected readonly kioskSecretVisible = signal(false);
  protected readonly modes = [
    { value: 'site', label: 'Servidor' },
    { value: 'central', label: 'NOC' },
    { value: 'sensor', label: 'Sensor' },
    { value: 'endpoint', label: 'Endpoint' },
  ] as const;
  protected readonly modeHelp =
    'Servidor: esta máquina y, si se activa, la red de la planta. Endpoint: PC o portátil. Sensor: puerto espejo. NOC: gestores.';
  protected readonly siteForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2)]],
    slug: ['', [Validators.pattern(/^[a-z0-9._-]*$/)]],
  });
  protected readonly agentForm = this.fb.nonNullable.group({
    agentId: ['', [Validators.required, Validators.pattern(/^[A-Za-z0-9._-]+$/)]],
    siteId: ['local', [Validators.required, Validators.pattern(/^[A-Za-z0-9._-]+$/)]],
    mode: ['site', Validators.required],
  });
  protected readonly kioskForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2)]],
    site: ['', Validators.required],
    dashboard: ['', Validators.required],
  });
  protected readonly dashboards = computed(() =>
    this.boards().map((item) => ({
      value: `custom:${item.id}`,
      label: item.site ? `${item.name} · ${item.site.name}` : item.name,
    })),
  );

  constructor() {
    this.tenants.load();
    effect(() => {
      this.tenants.slug();
      untracked(() => this.reload());
    });
  }

  protected fieldInvalid(
    form: 'site' | 'agent',
    name: 'name' | 'slug' | 'agentId' | 'siteId',
  ): boolean {
    const control = form === 'site' ? this.siteForm.get(name) : this.agentForm.get(name);
    return !!control && control.invalid && (control.touched || control.dirty);
  }

  protected modeLabel(mode: string): string {
    return this.modes.find((item) => item.value === mode)?.label ?? mode;
  }

  protected toggleSite(): void {
    this.siteOpen.update((open) => !open);
    this.agentOpen.set(false);
    this.editingSiteId.set(null);
    this.error.set(null);
    this.siteForm.reset({ name: '', slug: '' });
    this.siteForm.controls.slug.enable();
  }

  protected toggleAgent(): void {
    this.agentOpen.update((open) => !open);
    this.siteOpen.set(false);
    this.editingAgentId.set(null);
    this.error.set(null);
    this.agentForm.controls.agentId.enable();
    this.agentForm.reset({
      agentId: '',
      siteId: this.items()[0]?.slug ?? 'local',
      mode: 'site',
    });
  }

  protected toggleKiosk(): void {
    this.kioskOpen.update((open) => !open);
    this.error.set(null);
    this.kioskForm.reset({
      name: '',
      site: this.items()[0]?.slug ?? '',
      dashboard: this.dashboards()[0]?.value ?? '',
    });
  }

  protected submitKiosk(): void {
    if (this.kioskForm.invalid) {
      this.kioskForm.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    this.http
      .post<KioskDevice>(`${API_BASE_URL}/v1/kiosk/devices`, {
        ...this.kioskForm.getRawValue(),
        tenant: this.tenants.slug(),
      })
      .subscribe({
        next: (device) => {
          this.saving.set(false);
          this.kioskSecretVisible.set(false);
          this.kioskCredential.set(device);
          this.kioskOpen.set(false);
          this.reloadKiosks();
        },
        error: (err: { error?: { message?: string } }) => {
          this.saving.set(false);
          this.error.set(err.error?.message ?? 'No se pudo crear la pantalla de monitoreo.');
        },
      });
  }

  protected removeKiosk(device: KioskDevice): void {
    if (!window.confirm(`¿Eliminar la pantalla ${device.name}?`)) return;
    this.http.delete(`${API_BASE_URL}/v1/kiosk/devices/${device.id}`).subscribe({
      next: () => {
        if (this.kioskCredential()?.id === device.id) {
          this.kioskCredential.set(null);
        }
        this.reloadKiosks();
      },
      error: (err: { error?: { message?: string } }) =>
        this.error.set(err.error?.message ?? 'No se pudo eliminar la pantalla.'),
    });
  }

  protected rotateKiosk(device: KioskDevice): void {
    this.http
      .post<KioskDevice>(`${API_BASE_URL}/v1/kiosk/devices/${device.id}/rotate`, {})
      .subscribe({
        next: (rotated) => {
          this.kioskSecretVisible.set(false);
          this.kioskCredential.set(rotated);
          this.reloadKiosks();
        },
        error: (err: { error?: { message?: string } }) =>
          this.error.set(err.error?.message ?? 'No se pudo rotar la credencial.'),
      });
  }

  protected kioskActivationUrl(device: KioskDevice): string {
    return `${location.origin}/kiosk/activar?id=${encodeURIComponent(device.id)}`;
  }

  protected copyKioskCredential(device: KioskDevice): void {
    const text = `URL: ${this.kioskActivationUrl(device)}\nID: ${device.id}\nCredencial: ${device.secret ?? ''}`;
    void navigator.clipboard.writeText(text);
  }

  protected kioskSiteName(device: KioskDevice): string {
    return this.items().find((item) => item.slug === device.site)?.name ?? device.site;
  }

  protected kioskDashboardName(device: KioskDevice): string {
    const boardId = device.dashboard.startsWith('custom:')
      ? device.dashboard.slice('custom:'.length)
      : '';
    return this.boards().find((item) => item.id === boardId)?.name ?? device.dashboard;
  }

  protected kioskStatus(device: KioskDevice): string {
    if (device.revokedAt) return 'Revocada';
    return device.lastSeenAt ? 'Conectada' : 'Pendiente de activación';
  }

  protected editSite(item: TenantSite): void {
    this.siteOpen.set(true);
    this.agentOpen.set(false);
    this.editingSiteId.set(item.id);
    this.error.set(null);
    this.siteForm.reset({ name: item.name, slug: item.slug });
  }

  protected editAgent(item: EnrolledAgent): void {
    this.agentOpen.set(true);
    this.siteOpen.set(false);
    this.editingAgentId.set(item.id);
    this.error.set(null);
    this.agentForm.reset({ agentId: item.agentId, siteId: item.siteId, mode: item.mode });
    this.agentForm.controls.agentId.disable();
  }

  protected removeSite(item: TenantSite): void {
    if (!window.confirm(`¿Eliminar el sitio ${item.name}?`)) {
      return;
    }
    const slug = this.tenants.slug();
    this.http.delete(`${API_BASE_URL}/v1/tenants/${slug}/sites/${item.id}?as=${slug}`).subscribe({
      next: () => {
        if (this.editingSiteId() === item.id) {
          this.toggleSite();
          this.siteOpen.set(false);
        }
        this.reload();
      },
      error: (err: { error?: { message?: string } }) => {
        this.error.set(err.error?.message ?? 'No se pudo eliminar el sitio.');
      },
    });
  }

  protected removeAgent(item: EnrolledAgent): void {
    if (!window.confirm(`¿Eliminar el agente ${item.agentId}?`)) {
      return;
    }
    const slug = this.tenants.slug();
    this.http.delete(`${API_BASE_URL}/v1/tenants/${slug}/agents/${item.id}?as=${slug}`).subscribe({
      next: () => {
        if (this.editingAgentId() === item.id) {
          this.toggleAgent();
          this.agentOpen.set(false);
        }
        if (this.enrolled()?.id === item.id) {
          this.enrolled.set(null);
        }
        this.reload();
      },
      error: (err: { error?: { message?: string } }) => {
        this.error.set(err.error?.message ?? 'No se pudo eliminar el agente.');
      },
    });
  }

  protected submitSite(): void {
    if (this.siteForm.invalid) {
      this.siteForm.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    const slug = this.tenants.slug();
    const value = this.siteForm.getRawValue();
    const editingId = this.editingSiteId();
    const request = editingId
      ? this.http.patch<TenantSite>(
          `${API_BASE_URL}/v1/tenants/${slug}/sites/${editingId}?as=${slug}`,
          value,
        )
      : this.http.post<TenantSite>(`${API_BASE_URL}/v1/tenants/${slug}/sites?as=${slug}`, {
          name: value.name,
          slug: value.slug || undefined,
        });
    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.siteForm.reset({ name: '', slug: '' });
        this.siteOpen.set(false);
        this.editingSiteId.set(null);
        this.reload();
      },
      error: (err: { error?: { message?: string } }) => {
        this.saving.set(false);
        this.error.set(
          err.error?.message ??
            (editingId ? 'No se pudo guardar el sitio.' : 'No se pudo crear el sitio.'),
        );
      },
    });
  }

  protected downloadYaml(item: EnrolledAgent): void {
    const blob = new Blob([item.yaml], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'agent.yaml';
    link.click();
    URL.revokeObjectURL(url);
  }

  protected submitAgent(): void {
    if (this.agentForm.invalid) {
      this.agentForm.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    const slug = this.tenants.slug();
    const editingId = this.editingAgentId();
    const value = this.agentForm.getRawValue();
    const request = editingId
      ? this.http.patch<EnrolledAgent>(
          `${API_BASE_URL}/v1/tenants/${slug}/agents/${editingId}?as=${slug}`,
          {
            siteId: value.siteId,
            mode: value.mode,
          },
        )
      : this.http.post<EnrolledAgent>(
          `${API_BASE_URL}/v1/tenants/${slug}/agents?as=${slug}`,
          value,
        );
    request.subscribe({
      next: (agent) => {
        this.saving.set(false);
        this.agentForm.controls.agentId.enable();
        this.enrolled.set(agent);
        this.agentOpen.set(false);
        this.editingAgentId.set(null);
        this.reload();
      },
      error: (err: { error?: { message?: string } }) => {
        this.saving.set(false);
        this.error.set(
          err.error?.message ??
            (editingId ? 'No se pudo guardar el agente.' : 'No se pudo agregar el agente.'),
        );
      },
    });
  }

  private reload(): void {
    const slug = this.tenants.slug();
    this.http.get<TenantSite[]>(`${API_BASE_URL}/v1/tenants/${slug}/sites?as=${slug}`).subscribe({
      next: (sites) => this.items.set(sites),
      error: (err: { error?: { message?: string } }) => {
        this.error.set(err.error?.message ?? 'No se pudieron cargar los sitios.');
      },
    });
    this.http
      .get<EnrolledAgent[]>(`${API_BASE_URL}/v1/tenants/${slug}/agents?as=${slug}`)
      .subscribe({
        next: (agents) => this.agents.set(agents),
        error: (err: { error?: { message?: string } }) => {
          this.error.set(err.error?.message ?? 'No se pudieron cargar los agentes.');
        },
      });
    this.reloadKiosks();
    this.http
      .get<BoardOption[]>(`${API_BASE_URL}/v1/boards`, { params: { tenant: slug } })
      .subscribe({
        next: (rows) => this.boards.set(rows),
      });
  }

  private reloadKiosks(): void {
    const tenant = encodeURIComponent(this.tenants.slug());
    this.http.get<KioskDevice[]>(`${API_BASE_URL}/v1/kiosk/devices?tenant=${tenant}`).subscribe({
      next: (devices) => this.kiosks.set(devices),
      error: (err: { error?: { message?: string } }) =>
        this.error.set(err.error?.message ?? 'No se pudieron cargar las pantallas.'),
    });
  }
}
