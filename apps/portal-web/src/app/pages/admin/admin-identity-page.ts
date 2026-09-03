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
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';

type TenantIdentity = {
  tenant: string;
  emailDomain: string;
  mfaRequired: boolean;
  entraEnabled: boolean;
  entraTenantId: string;
  entraClientId: string;
  hasEntraSecret: boolean;
  adEnabled: boolean;
  adConnectionUrl: string;
  adBindDn: string;
  hasAdBindPassword: boolean;
  adUsersDn: string;
};

@Component({
  selector: 'app-admin-identity-page',
  imports: [ReactiveFormsModule, EkuPageHeaderComponent, EkuErrorStateComponent],
  templateUrl: './admin-identity-page.html',
  styleUrl: './admin-identity-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminIdentityPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly tenants = inject(TenantService);

  protected readonly error = signal<string | null>(null);
  protected readonly saved = signal(false);
  protected readonly loading = signal(false);
  protected readonly hasEntraSecret = signal(false);
  protected readonly hasAdBindPassword = signal(false);
  protected readonly emailDomain = signal('');
  protected readonly tenantName = computed(
    () => this.tenants.current()?.name || this.tenants.slug() || 'tenant',
  );
  protected readonly form = this.fb.nonNullable.group({
    mfaRequired: [false],
    entraEnabled: [false],
    entraTenantId: [''],
    entraClientId: [''],
    entraClientSecret: [''],
    adEnabled: [false],
    adConnectionUrl: [''],
    adBindDn: [''],
    adBindPassword: [''],
    adUsersDn: [''],
  });

  constructor() {
    this.form.controls.entraEnabled.valueChanges.subscribe(() => this.syncValidators());
    this.form.controls.adEnabled.valueChanges.subscribe(() => this.syncValidators());
    effect(() => {
      this.tenants.slug();
      untracked(() => this.load());
    });
  }

  protected fieldInvalid(
    name: 'entraTenantId' | 'entraClientId' | 'entraClientSecret' | 'adConnectionUrl' | 'adBindDn' | 'adBindPassword' | 'adUsersDn',
  ): boolean {
    const control = this.form.controls[name];
    return control.invalid && (control.touched || control.dirty);
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
    const value = this.form.getRawValue();
    this.http
      .put<TenantIdentity>(`${API_BASE_URL}/v1/identity`, {
        ...value,
        entraClientSecret: value.entraClientSecret || undefined,
        adBindPassword: value.adBindPassword || undefined,
      })
      .subscribe({
        next: (identity) => {
          this.apply(identity);
          this.loading.set(false);
          this.saved.set(true);
        },
        error: (error: { error?: { message?: string } }) => {
          this.loading.set(false);
          this.error.set(error.error?.message ?? 'No se pudo guardar la identidad.');
        },
      });
  }

  private load(): void {
    this.http.get<TenantIdentity>(`${API_BASE_URL}/v1/identity`).subscribe({
      next: (identity) => {
        this.apply(identity);
        this.error.set(null);
      },
      error: (error: { error?: { message?: string } }) => {
        this.error.set(error.error?.message ?? 'No se pudo leer la identidad del tenant.');
      },
    });
  }

  private apply(identity: TenantIdentity): void {
    this.hasEntraSecret.set(identity.hasEntraSecret);
    this.hasAdBindPassword.set(identity.hasAdBindPassword);
    this.emailDomain.set(identity.emailDomain);
    this.form.patchValue(
      {
        mfaRequired: identity.mfaRequired,
        entraEnabled: identity.entraEnabled,
        entraTenantId: identity.entraTenantId,
        entraClientId: identity.entraClientId,
        entraClientSecret: '',
        adEnabled: identity.adEnabled,
        adConnectionUrl: identity.adConnectionUrl,
        adBindDn: identity.adBindDn,
        adBindPassword: '',
        adUsersDn: identity.adUsersDn,
      },
      { emitEvent: false },
    );
    this.syncValidators();
  }

  private syncValidators(): void {
    const entra = this.form.controls.entraEnabled.value;
    const ad = this.form.controls.adEnabled.value;
    this.form.controls.entraTenantId.setValidators(entra ? [Validators.required] : []);
    this.form.controls.entraClientId.setValidators(entra ? [Validators.required] : []);
    this.form.controls.entraClientSecret.setValidators(
      entra && !this.hasEntraSecret() ? [Validators.required] : [],
    );
    this.form.controls.adConnectionUrl.setValidators(ad ? [Validators.required] : []);
    this.form.controls.adBindDn.setValidators(ad ? [Validators.required] : []);
    this.form.controls.adBindPassword.setValidators(
      ad && !this.hasAdBindPassword() ? [Validators.required] : [],
    );
    this.form.controls.adUsersDn.setValidators(ad ? [Validators.required] : []);
    for (const name of [
      'entraTenantId',
      'entraClientId',
      'entraClientSecret',
      'adConnectionUrl',
      'adBindDn',
      'adBindPassword',
      'adUsersDn',
    ] as const) {
      this.form.controls[name].updateValueAndValidity({ emitEvent: false });
    }
  }
}
