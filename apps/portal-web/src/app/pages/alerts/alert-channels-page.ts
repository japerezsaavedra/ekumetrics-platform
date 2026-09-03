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
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { API_BASE_URL } from '../../core/api';
import { TenantService } from '../../core/tenant';
import { EkuEmptyStateComponent } from '../../shared/eku/empty-state/eku-empty-state';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';

type AlertChannel = {
  id: string;
  tenant: string;
  name: string;
  type: 'email' | 'slack' | 'webhook';
  enabled: boolean;
  severities: string[];
  to: string;
  from: string;
  smarthost: string;
  username: string;
  hasPassword: boolean;
  slackChannel: string;
  hasWebhookUrl: boolean;
  url: string;
  hasToken: boolean;
};

@Component({
  selector: 'app-alert-channels-page',
  imports: [
    ReactiveFormsModule,
    EkuEmptyStateComponent,
    EkuErrorStateComponent,
    EkuPageHeaderComponent,
  ],
  templateUrl: './alert-channels-page.html',
  styleUrl: './alert-channels-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertChannelsPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly tenants = inject(TenantService);

  protected readonly items = signal<AlertChannel[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly formOpen = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly keepSlackUrl = signal(false);
  protected readonly saving = signal(false);
  protected readonly tenantName = computed(
    () => this.tenants.current()?.name || this.tenants.slug() || 'tenant',
  );
  protected readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.pattern(/^[a-zA-Z0-9._-]{2,64}$/)]],
    type: ['email' as AlertChannel['type'], [Validators.required]],
    enabled: [true],
    critical: [true],
    warning: [true],
    info: [false],
    to: [''],
    from: [''],
    smarthost: [''],
    username: [''],
    password: [''],
    webhookUrl: [''],
    slackChannel: [''],
    url: [''],
    token: [''],
  });

  constructor() {
    this.form.controls.type.valueChanges.subscribe(() => this.syncValidators());
    this.syncValidators();
    effect(() => {
      this.tenants.slug();
      untracked(() => this.load());
    });
  }

  protected typeLabel(type: string): string {
    return { email: 'Correo', slack: 'Slack', webhook: 'Webhook' }[type] ?? type;
  }

  protected severityLabel(value: string): string {
    return { critical: 'Crítica', warning: 'Advertencia', info: 'Informativa' }[value] ?? value;
  }

  protected fieldInvalid(name: 'name' | 'to' | 'smarthost' | 'webhookUrl' | 'url'): boolean {
    const control = this.form.controls[name];
    return control.invalid && (control.touched || control.dirty);
  }

  protected openCreate(): void {
    this.editingId.set(null);
    this.form.reset({
      name: '',
      type: 'email',
      enabled: true,
      critical: true,
      warning: true,
      info: false,
      to: '',
      from: '',
      smarthost: '',
      username: '',
      password: '',
      webhookUrl: '',
      slackChannel: '',
      url: '',
      token: '',
    });
    this.keepSlackUrl.set(false);
    this.syncValidators();
    this.formOpen.set(true);
    this.error.set(null);
  }

  protected openEdit(channel: AlertChannel): void {
    this.editingId.set(channel.id);
    this.form.reset({
      name: channel.name,
      type: channel.type,
      enabled: channel.enabled,
      critical: channel.severities.includes('critical'),
      warning: channel.severities.includes('warning'),
      info: channel.severities.includes('info'),
      to: channel.to,
      from: channel.from,
      smarthost: channel.smarthost,
      username: channel.username,
      password: '',
      webhookUrl: '',
      slackChannel: channel.slackChannel,
      url: channel.url,
      token: '',
    });
    this.keepSlackUrl.set(channel.hasWebhookUrl);
    this.syncValidators();
    this.formOpen.set(true);
    this.error.set(null);
  }

  protected closeForm(): void {
    this.formOpen.set(false);
    this.editingId.set(null);
  }

  protected submit(): void {
    this.syncValidators();
    const severities = this.selectedSeverities();
    if (this.form.invalid || severities.length === 0) {
      this.form.markAllAsTouched();
      if (severities.length === 0) {
        this.error.set('Seleccione al menos una severidad.');
      }
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    const value = this.form.getRawValue();
    const body = {
      name: value.name,
      type: value.type,
      enabled: value.enabled,
      severities,
      to: value.to,
      from: value.from,
      smarthost: value.smarthost,
      username: value.username,
      password: value.password || undefined,
      webhookUrl: value.webhookUrl || undefined,
      channel: value.slackChannel,
      url: value.url,
      token: value.token || undefined,
    };
    const id = this.editingId();
    const request = id
      ? this.http.patch<AlertChannel>(`${API_BASE_URL}/v1/alerts/channels/${id}`, body)
      : this.http.post<AlertChannel>(`${API_BASE_URL}/v1/alerts/channels`, body);
    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.closeForm();
        this.load();
      },
      error: (error: { error?: { message?: string } }) => {
        this.saving.set(false);
        this.error.set(error.error?.message ?? 'No se pudo guardar el canal.');
      },
    });
  }

  protected remove(channel: AlertChannel): void {
    if (!window.confirm(`¿Eliminar el canal ${channel.name}?`)) return;
    this.http.delete(`${API_BASE_URL}/v1/alerts/channels/${channel.id}`).subscribe({
      next: () => this.load(),
      error: (error: { error?: { message?: string } }) => {
        this.error.set(error.error?.message ?? 'No se pudo eliminar el canal.');
      },
    });
  }

  private selectedSeverities(): string[] {
    const value = this.form.getRawValue();
    return [
      value.critical ? 'critical' : '',
      value.warning ? 'warning' : '',
      value.info ? 'info' : '',
    ].filter(Boolean);
  }

  private syncValidators(): void {
    const type = this.form.controls.type.value;
    this.form.controls.to.setValidators(
      type === 'email' ? [Validators.required, Validators.email] : [],
    );
    this.form.controls.smarthost.setValidators(type === 'email' ? [Validators.required] : []);
    this.form.controls.webhookUrl.setValidators(
      type === 'slack' && !this.keepSlackUrl() ? [Validators.required] : [],
    );
    this.form.controls.url.setValidators(type === 'webhook' ? [Validators.required] : []);
    for (const name of ['to', 'smarthost', 'webhookUrl', 'url'] as const) {
      this.form.controls[name].updateValueAndValidity({ emitEvent: false });
    }
  }

  private load(): void {
    this.http
      .get<{ tenant: string; channels: AlertChannel[] }>(`${API_BASE_URL}/v1/alerts/channels`)
      .subscribe({
        next: (value) => {
          this.items.set(value.channels);
          this.error.set(null);
        },
        error: (error: { error?: { message?: string } }) => {
          this.error.set(error.error?.message ?? 'No se pudieron leer los canales.');
        },
      });
  }
}
