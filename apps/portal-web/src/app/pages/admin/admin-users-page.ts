import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { API_BASE_URL } from '../../core/api';
import { TenantService } from '../../core/tenant';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';
import { emailMatchesDomain } from '../../validators/email-domain';

type AdminUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  tenant: { name: string; slug: string; emailDomain?: string | null };
};

@Component({
  selector: 'app-admin-users-page',
  imports: [ReactiveFormsModule, EkuPageHeaderComponent, EkuErrorStateComponent],
  templateUrl: './admin-users-page.html',
  styleUrl: './admin-users-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminUsersPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly tenants = inject(TenantService);

  protected readonly items = signal<AdminUser[]>([]);
  protected readonly tenantOptions = this.tenants.tenants;
  protected readonly isOperator = this.tenants.isOperator;
  protected readonly formOpen = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly form = this.fb.nonNullable.group({
    tenantSlug: [this.tenants.slug(), Validators.required],
    displayName: ['', [Validators.required, Validators.minLength(2)]],
    email: [
      '',
      [Validators.required, Validators.email, emailMatchesDomain(() => this.selectedDomain())],
    ],
    role: ['admin', Validators.required],
  });

  constructor() {
    this.tenants.load();
    this.reload();
    this.form.controls.tenantSlug.valueChanges.subscribe(() => {
      this.form.controls.email.updateValueAndValidity();
    });
  }

  protected selectedDomain(): string {
    const slug = this.isOperator() ? this.form.controls.tenantSlug.value : this.tenants.slug();
    return this.tenantOptions().find((item) => item.slug === slug)?.emailDomain ?? '';
  }

  protected domainHint(): string {
    const domain = this.selectedDomain();
    return domain ? `@${domain}` : '@dominio-del-tenant';
  }

  protected fieldInvalid(name: 'tenantSlug' | 'displayName' | 'email' | 'role'): boolean {
    const control = this.form.controls[name];
    return control.invalid && (control.touched || control.dirty);
  }

  protected toggleForm(): void {
    this.formOpen.update((open) => !open);
    this.error.set(null);
    if (!this.form.controls.tenantSlug.value) {
      this.form.controls.tenantSlug.setValue(this.tenants.slug());
    }
  }

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    const value = this.form.getRawValue();
    const tenantSlug = this.isOperator() ? value.tenantSlug : this.tenants.slug();
    this.http
      .post<AdminUser>(`${API_BASE_URL}/v1/admin/users?as=${this.tenants.slug()}`, {
        ...value,
        tenantSlug,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.form.reset({
            tenantSlug,
            displayName: '',
            email: '',
            role: 'admin',
          });
          this.formOpen.set(false);
          this.reload();
          this.tenants.load();
        },
        error: (err: { error?: { message?: string } }) => {
          this.saving.set(false);
          this.error.set(err.error?.message ?? 'No se pudo crear el usuario.');
        },
      });
  }

  private reload(): void {
    this.http.get<AdminUser[]>(`${API_BASE_URL}/v1/admin/users?as=${this.tenants.slug()}`).subscribe({
      next: (users) => this.items.set(users),
      error: (err: { error?: { message?: string } }) => {
        this.error.set(err.error?.message ?? 'No se pudieron cargar los usuarios.');
      },
    });
  }
}
