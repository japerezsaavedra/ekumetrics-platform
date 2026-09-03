import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { API_BASE_URL } from '../../core/api';
import { AuthService } from '../../core/auth';
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
  temporaryPassword?: string;
};

@Component({
  selector: 'app-admin-users-page',
  imports: [
    ReactiveFormsModule,
    MatIcon,
    MatTooltip,
    EkuPageHeaderComponent,
    EkuErrorStateComponent,
  ],
  templateUrl: './admin-users-page.html',
  styleUrl: './admin-users-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminUsersPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly tenants = inject(TenantService);
  private readonly auth = inject(AuthService);

  protected readonly items = signal<AdminUser[]>([]);
  protected readonly tenantOptions = this.tenants.tenants;
  protected readonly isOperator = this.tenants.isOperator;
  protected readonly formOpen = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly created = signal<{
    email: string;
    temporaryPassword: string;
    reset?: boolean;
  } | null>(null);
  protected readonly passwordVisible = signal(false);
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
    const slug = this.isOperator()
      ? (this.form?.controls.tenantSlug.value ?? this.tenants.slug())
      : this.tenants.slug();
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
    this.editingId.set(null);
    this.error.set(null);
    this.created.set(null);
    this.passwordVisible.set(false);
    this.form.controls.email.enable();
    this.form.controls.tenantSlug.enable();
    this.form.reset({
      tenantSlug: this.tenants.slug(),
      displayName: '',
      email: '',
      role: 'admin',
    });
  }

  protected edit(item: AdminUser): void {
    this.formOpen.set(true);
    this.editingId.set(item.id);
    this.error.set(null);
    this.created.set(null);
    this.passwordVisible.set(false);
    this.form.reset({
      tenantSlug: item.tenant.slug,
      displayName: item.displayName,
      email: item.email,
      role: item.role,
    });
    this.form.controls.email.disable();
    this.form.controls.tenantSlug.disable();
  }

  protected resetPassword(item: AdminUser): void {
    if (!window.confirm(`¿Generar una nueva clave para ${item.displayName}?`)) {
      return;
    }
    this.error.set(null);
    this.http
      .post<{ email: string; temporaryPassword: string }>(
        `${API_BASE_URL}/v1/admin/users/${item.id}/reset-password?as=${this.tenants.slug()}`,
        {},
      )
      .subscribe({
        next: (account) => {
          this.passwordVisible.set(false);
          this.created.set({ ...account, reset: true });
        },
        error: (err: { error?: { message?: string } }) => {
          this.error.set(err.error?.message ?? 'No se pudo restablecer la clave.');
        },
      });
  }

  protected remove(item: AdminUser): void {
    if (item.email === this.auth.email()) {
      this.error.set('No puede eliminar su propia cuenta.');
      return;
    }
    if (!window.confirm(`¿Eliminar a ${item.displayName}?`)) {
      return;
    }
    this.http
      .delete(`${API_BASE_URL}/v1/admin/users/${item.id}?as=${this.tenants.slug()}`)
      .subscribe({
        next: () => {
          if (this.editingId() === item.id) {
            this.toggleForm();
            this.formOpen.set(false);
          }
          this.reload();
        },
        error: (err: { error?: { message?: string } }) => {
          this.error.set(err.error?.message ?? 'No se pudo eliminar el usuario.');
        },
      });
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
    const editingId = this.editingId();
    const request = editingId
      ? this.http.patch<AdminUser>(
          `${API_BASE_URL}/v1/admin/users/${editingId}?as=${this.tenants.slug()}`,
          {
            displayName: value.displayName,
            role: value.role,
          },
        )
      : this.http.post<AdminUser>(`${API_BASE_URL}/v1/admin/users?as=${this.tenants.slug()}`, {
          ...value,
          tenantSlug,
        });
    request.subscribe({
      next: (user) => {
        this.saving.set(false);
        this.form.controls.email.enable();
        this.form.controls.tenantSlug.enable();
        this.form.reset({
          tenantSlug,
          displayName: '',
          email: '',
          role: 'admin',
        });
        this.formOpen.set(false);
        this.editingId.set(null);
        this.created.set(
          !editingId && user.temporaryPassword
            ? { email: user.email, temporaryPassword: user.temporaryPassword }
            : null,
        );
        this.reload();
        this.tenants.load();
      },
      error: (err: { error?: { message?: string } }) => {
        this.saving.set(false);
        this.error.set(
          err.error?.message ??
            (editingId ? 'No se pudo guardar el usuario.' : 'No se pudo crear el usuario.'),
        );
      },
    });
  }

  private reload(): void {
    this.http
      .get<AdminUser[]>(`${API_BASE_URL}/v1/admin/users?as=${this.tenants.slug()}`)
      .subscribe({
        next: (users) => this.items.set(users),
        error: (err: { error?: { message?: string } }) => {
          this.error.set(err.error?.message ?? 'No se pudieron cargar los usuarios.');
        },
      });
  }
}
