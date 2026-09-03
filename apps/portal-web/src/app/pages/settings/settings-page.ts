import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { API_BASE_URL } from '../../core/api';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';

type AiServiceOption = {
  id: string;
  label: string;
  models: string[];
  defaultModel: string;
  configured: boolean;
  hasApiKey?: boolean;
  savedModel?: string;
  savedBaseUrl?: string;
  needsKey: boolean;
  needsBaseUrl: boolean;
  hint: string;
};

type AiActive = {
  label: string;
  model: string;
  configured: boolean;
  online: boolean;
  detail: string;
};

type AiSettings = {
  service: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  systemPrompt?: string;
  services: AiServiceOption[];
  active?: AiActive;
};

type KnowledgeDocument = {
  id: string;
  sourceKey: string;
  sourceType: 'product' | 'runbook' | 'postmortem';
  title: string;
  version: string;
  component: string | null;
  checksum: string;
  approvedBy: string;
  approvedAt: string;
  validFrom: string;
  validUntil: string | null;
  updatedAt: string;
  chunkCount: number;
  status: 'active' | 'scheduled' | 'expired';
};

@Component({
  selector: 'app-settings-page',
  imports: [ReactiveFormsModule, EkuPageHeaderComponent, EkuErrorStateComponent],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);

  protected readonly catalog = signal<AiServiceOption[]>([]);
  protected readonly active = signal<AiActive | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly saved = signal(false);
  protected readonly loading = signal(false);
  protected readonly knowledge = signal<KnowledgeDocument[]>([]);
  protected readonly knowledgeLoading = signal(false);
  protected readonly knowledgeError = signal<string | null>(null);
  protected readonly knowledgeSaved = signal(false);
  private readonly savedService = signal('ollama');
  private readonly savedHasKey = signal(false);
  private readonly savedModel = signal('');

  protected readonly form = this.fb.nonNullable.group({
    service: ['ollama', [Validators.required]],
    model: ['qwen3.5:4b', [Validators.required]],
    apiKey: [''],
    baseUrl: [''],
    systemPrompt: [''],
  });

  protected readonly knowledgeForm = this.fb.nonNullable.group({
    sourceKey: ['', [Validators.required, Validators.pattern(/^[A-Za-z0-9._:/-]+$/)]],
    sourceType: ['runbook' as KnowledgeDocument['sourceType'], [Validators.required]],
    title: ['', [Validators.required, Validators.maxLength(300)]],
    version: ['1.0.0', [Validators.required, Validators.pattern(/^[A-Za-z0-9._:/-]+$/)]],
    component: ['', [Validators.pattern(/^[A-Za-z0-9._:/-]*$/)]],
    validUntil: [''],
    content: ['', [Validators.required, Validators.minLength(10), Validators.maxLength(200_000)]],
  });

  constructor() {
    this.form.controls.service.valueChanges.subscribe((serviceId) => {
      this.applyServiceDefaults(serviceId);
      this.syncValidators();
    });
    this.http.get<AiSettings>(`${API_BASE_URL}/v1/ai/settings`).subscribe({
      next: (value) => this.applySettings(value),
      error: () => this.error.set('No se pudo leer la configuracion. Inicie platform-api.'),
    });
    this.loadKnowledge();
  }

  protected selectedService(): AiServiceOption | undefined {
    const id = this.form.controls.service.value;
    return this.catalog().find((item) => item.id === id);
  }

  protected hasSavedKey(): boolean {
    return Boolean(this.selectedService()?.hasApiKey);
  }

  protected catalogModels(): string[] {
    return this.selectedService()?.models ?? [];
  }

  protected savedModelOutsideCatalog(): string | null {
    const model = this.savedModel();
    const models = this.catalogModels();
    if (!model || !models.length || models.includes(model)) {
      return null;
    }
    if (this.form.controls.service.value !== this.savedService()) {
      return null;
    }
    return model;
  }

  protected submit(): void {
    this.syncValidators();
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.saved.set(false);
    const { service, model, apiKey, baseUrl, systemPrompt } = this.form.getRawValue();
    this.http
      .put<AiSettings>(`${API_BASE_URL}/v1/ai/settings`, {
        service,
        model,
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
        systemPrompt,
      })
      .subscribe({
        next: (value) => {
          this.applySettings(value);
          this.form.controls.apiKey.setValue('');
          this.loading.set(false);
          this.saved.set(true);
        },
        error: (err: { error?: { message?: string | string[] } }) => {
          this.loading.set(false);
          const raw = err.error?.message;
          this.error.set(
            Array.isArray(raw) ? raw.join(' ') : (raw ?? 'No se pudo guardar la configuracion.'),
          );
        },
      });
  }

  protected fieldInvalid(name: 'service' | 'model' | 'apiKey' | 'baseUrl'): boolean {
    const control = this.form.controls[name];
    return control.invalid && (control.touched || control.dirty);
  }

  protected saveKnowledge(): void {
    if (this.knowledgeForm.invalid) {
      this.knowledgeForm.markAllAsTouched();
      return;
    }
    this.knowledgeLoading.set(true);
    this.knowledgeError.set(null);
    this.knowledgeSaved.set(false);
    const value = this.knowledgeForm.getRawValue();
    this.http
      .post(`${API_BASE_URL}/v1/ai/knowledge/documents`, {
        ...value,
        component: value.component.trim() || undefined,
        validUntil: value.validUntil ? new Date(value.validUntil).toISOString() : undefined,
      })
      .subscribe({
        next: () => {
          this.knowledgeLoading.set(false);
          this.knowledgeSaved.set(true);
          this.knowledgeForm.reset({
            sourceKey: '',
            sourceType: 'runbook',
            title: '',
            version: '1.0.0',
            component: '',
            validUntil: '',
            content: '',
          });
          this.loadKnowledge();
        },
        error: (error: { error?: { message?: string | string[] } }) => {
          this.knowledgeLoading.set(false);
          this.knowledgeError.set(this.apiError(error, 'No se pudo indexar el documento.'));
        },
      });
  }

  protected deleteKnowledge(item: KnowledgeDocument): void {
    if (!window.confirm(`Eliminar "${item.title}" y todos sus fragmentos?`)) return;
    this.knowledgeLoading.set(true);
    this.knowledgeError.set(null);
    this.http.delete(`${API_BASE_URL}/v1/ai/knowledge/documents/${item.id}`).subscribe({
      next: () => {
        this.knowledgeLoading.set(false);
        this.loadKnowledge();
      },
      error: (error: { error?: { message?: string | string[] } }) => {
        this.knowledgeLoading.set(false);
        this.knowledgeError.set(this.apiError(error, 'No se pudo eliminar el documento.'));
      },
    });
  }

  protected sourceTypeLabel(value: KnowledgeDocument['sourceType']): string {
    return { product: 'Producto', runbook: 'Runbook', postmortem: 'Postmortem' }[value];
  }

  protected statusLabel(value: KnowledgeDocument['status']): string {
    return { active: 'Vigente', scheduled: 'Programado', expired: 'Vencido' }[value];
  }

  protected formatDate(value: string): string {
    return new Date(value).toLocaleDateString('es', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  private applySettings(value: AiSettings): void {
    this.catalog.set(value.services ?? this.catalog());
    this.active.set(value.active ?? this.active());
    this.savedService.set(value.service);
    this.savedHasKey.set(value.hasApiKey);
    this.savedModel.set(value.model);
    this.form.patchValue(
      {
        service: value.service,
        model: value.model,
        baseUrl: value.baseUrl ?? '',
        apiKey: '',
        systemPrompt: value.systemPrompt ?? '',
      },
      { emitEvent: false },
    );
    this.syncValidators();
  }

  private applyServiceDefaults(serviceId: string): void {
    const service = this.catalog().find((item) => item.id === serviceId);
    this.form.controls.apiKey.setValue('');
    if (service?.savedModel) {
      this.form.controls.model.setValue(service.savedModel);
    } else if (service?.models.length && !service.models.includes(this.form.controls.model.value)) {
      this.form.controls.model.setValue(service.defaultModel || service.models[0]);
    }
    this.form.controls.baseUrl.setValue(
      service?.id === 'openai_compat' ? service.savedBaseUrl || '' : '',
    );
  }

  private syncValidators(): void {
    const service = this.selectedService();
    this.form.controls.apiKey.setValidators(
      service?.needsKey && !this.hasSavedKey() ? [Validators.required] : [],
    );
    this.form.controls.baseUrl.setValidators(service?.needsBaseUrl ? [Validators.required] : []);
    this.form.controls.apiKey.updateValueAndValidity({ emitEvent: false });
    this.form.controls.baseUrl.updateValueAndValidity({ emitEvent: false });
  }

  private loadKnowledge(): void {
    this.http.get<KnowledgeDocument[]>(`${API_BASE_URL}/v1/ai/knowledge/documents`).subscribe({
      next: (items) => this.knowledge.set(items),
      error: (error: { error?: { message?: string | string[] } }) =>
        this.knowledgeError.set(this.apiError(error, 'No se pudo leer el corpus aprobado.')),
    });
  }

  private apiError(error: { error?: { message?: string | string[] } }, fallback: string): string {
    const raw = error.error?.message;
    return Array.isArray(raw) ? raw.join(' ') : (raw ?? fallback);
  }
}
