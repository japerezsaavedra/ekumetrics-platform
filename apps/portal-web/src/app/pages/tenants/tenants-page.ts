import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { API_BASE_URL } from '../../core/api';
import { TenantService, type TenantOption } from '../../core/tenant';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';
import {
  CORPORATE_DOMAIN_PATTERN,
  corporateDomainValidators,
  emailMatchesSiblingDomain,
} from '../../validators/email-domain';

@Component({
  selector: 'app-tenants-page',
  imports: [ReactiveFormsModule, EkuPageHeaderComponent, EkuErrorStateComponent],
  templateUrl: './tenants-page.html',
  styleUrl: './tenants-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantsPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly tenants = inject(TenantService);

  protected readonly items = this.tenants.tenants;
  protected readonly isOperator = this.tenants.isOperator;
  protected readonly formOpen = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly form = this.fb.nonNullable.group(
    {
      name: ['', [Validators.required, Validators.minLength(2)]],
      slug: ['', [Validators.pattern(/^[a-z0-9._-]*$/)]],
      emailDomain: ['', corporateDomainValidators],
      adminName: ['', [Validators.required, Validators.minLength(2)]],
      adminEmail: ['', [Validators.required, Validators.email]],
      siteName: ['Sede principal', [Validators.required, Validators.minLength(2)]],
      siteSlug: ['local', [Validators.pattern(/^[a-z0-9._-]+$/)]],
    },
    { validators: [emailMatchesSiblingDomain('emailDomain', 'adminEmail')] },
  );

  constructor() {
    this.tenants.load();
  }

  protected fieldInvalid(
    name: 'name' | 'slug' | 'emailDomain' | 'adminName' | 'adminEmail' | 'siteName' | 'siteSlug',
  ): boolean {
    const control = this.form.controls[name];
    return control.invalid && (control.touched || control.dirty);
  }

  protected emailDomainInvalid(): boolean {
    return this.form.hasError('emailDomain') && (this.form.controls.adminEmail.touched || this.form.controls.adminEmail.dirty);
  }

  protected domainHint(): string {
    const domain = this.form.controls.emailDomain.value.trim().toLowerCase();
    return domain && CORPORATE_DOMAIN_PATTERN.test(domain) ? `@${domain}` : '@cliente.com';
  }

  protected toggleForm(): void {
    this.formOpen.update((open) => !open);
    this.error.set(null);
  }

  protected submit(): void {
    if (!this.isOperator()) {
      this.error.set('Solo Gradotech puede crear tenants.');
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    const value = this.form.getRawValue();
    this.http
      .post<TenantOption>(`${API_BASE_URL}/v1/tenants?as=default`, {
        name: value.name,
        slug: value.slug || undefined,
        emailDomain: value.emailDomain,
        adminName: value.adminName,
        adminEmail: value.adminEmail,
        siteName: value.siteName,
        siteSlug: value.siteSlug || undefined,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.form.reset({
            name: '',
            slug: '',
            emailDomain: '',
            adminName: '',
            adminEmail: '',
            siteName: 'Sede principal',
            siteSlug: 'local',
          });
          this.formOpen.set(false);
          this.tenants.load();
        },
        error: (err: { error?: { message?: string } }) => {
          this.saving.set(false);
          this.error.set(err.error?.message ?? 'No se pudo crear el tenant.');
        },
      });
  }

  protected useTenant(slug: string): void {
    this.tenants.select(slug);
  }

  protected adminLabel(item: TenantOption): string {
    const admin = item.users?.[0];
    if (!admin) {
      return item.slug === 'default' ? 'Operador Gradotech' : 'Sin administrador';
    }
    return `${admin.displayName} · ${admin.email}`;
  }
}
