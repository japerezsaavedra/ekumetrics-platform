import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButton } from '@angular/material/button';
import { MatCard, MatCardContent, MatCardHeader, MatCardTitle } from '@angular/material/card';
import { MatFormField, MatHint, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatOption, MatSelect } from '@angular/material/select';
import { API_BASE_URL } from '../../core/api';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';

type AiServiceOption = {
  id: string;
  label: string;
  models: string[];
  defaultModel: string;
  configured: boolean;
  needsKey: boolean;
  needsBaseUrl: boolean;
  hint: string;
};

type AiSettings = {
  service: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  services: AiServiceOption[];
};

@Component({
  selector: 'app-settings-page',
  imports: [
    ReactiveFormsModule,
    MatCard,
    MatCardHeader,
    MatCardTitle,
    MatCardContent,
    MatFormField,
    MatLabel,
    MatInput,
    MatHint,
    MatSelect,
    MatOption,
    MatButton,
    EkuPageHeaderComponent,
    EkuErrorStateComponent,
  ],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);

  protected readonly catalog = signal<AiServiceOption[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly saved = signal(false);
  protected readonly loading = signal(false);
  private readonly savedService = signal('ollama');
  private readonly savedHasKey = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    service: ['ollama', [Validators.required]],
    model: ['qwen2.5:14b', [Validators.required]],
    apiKey: [''],
    baseUrl: [''],
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
  }

  protected selectedService(): AiServiceOption | undefined {
    const id = this.form.controls.service.value;
    return this.catalog().find((item) => item.id === id);
  }

  protected hasSavedKey(): boolean {
    return this.savedHasKey() && this.form.controls.service.value === this.savedService();
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
    const { service, model, apiKey, baseUrl } = this.form.getRawValue();
    this.http
      .put<AiSettings>(`${API_BASE_URL}/v1/ai/settings`, {
        service,
        model,
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
      })
      .subscribe({
        next: (value) => {
          this.applySettings({ ...value, services: this.catalog() });
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

  private applySettings(value: AiSettings): void {
    this.catalog.set(value.services ?? this.catalog());
    this.savedService.set(value.service);
    this.savedHasKey.set(value.hasApiKey);
    this.form.patchValue(
      {
        service: value.service,
        model: value.model,
        baseUrl: value.baseUrl ?? '',
        apiKey: '',
      },
      { emitEvent: false },
    );
    this.syncValidators();
  }

  private applyServiceDefaults(serviceId: string): void {
    const service = this.catalog().find((item) => item.id === serviceId);
    if (service?.defaultModel) {
      this.form.controls.model.setValue(service.defaultModel);
    }
    if (service?.id !== 'openai_compat') {
      this.form.controls.baseUrl.setValue('');
    }
  }

  private syncValidators(): void {
    const service = this.selectedService();
    this.form.controls.apiKey.setValidators(
      service?.needsKey && !this.hasSavedKey() ? [Validators.required] : [],
    );
    this.form.controls.baseUrl.setValidators(
      service?.needsBaseUrl ? [Validators.required] : [],
    );
    this.form.controls.apiKey.updateValueAndValidity({ emitEvent: false });
    this.form.controls.baseUrl.updateValueAndValidity({ emitEvent: false });
  }
}
