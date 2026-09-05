import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { API_BASE_URL } from '../../core/api';
import { TenantService, type TenantOption } from '../../core/tenant';
import {
  TENANT_MODULE_CATALOG,
  parseTenantModules,
  type OptionalTenantModule,
} from '../../core/tenant-modules';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';
import {
  CORPORATE_DOMAIN_PATTERN,
  corporateDomainValidators,
  emailMatchesSiblingDomain,
} from '../../validators/email-domain';

@Component({
  selector: 'app-tenants-page',
  imports: [
    ReactiveFormsModule,
    MatIcon,
    MatTooltip,
    EkuPageHeaderComponent,
    EkuErrorStateComponent,
  ],
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
  protected readonly moduleCatalog = TENANT_MODULE_CATALOG;
  protected readonly formOpen = signal(false);
  protected readonly editingSlug = signal<string | null>(null);
  protected readonly created = signal<{ email: string; temporaryPassword: string } | null>(null);
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
      modules: this.fb.nonNullable.group({
        icewarp: false,
        sap: false,
        databases: false,
        queues: false,
        network: false,
      }),
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
    return (
      this.form.hasError('emailDomain') &&
      (this.form.controls.adminEmail.touched || this.form.controls.adminEmail.dirty)
    );
  }

  protected domainHint(): string {
    const domain = this.form.controls.emailDomain.value.trim().toLowerCase();
    return domain && CORPORATE_DOMAIN_PATTERN.test(domain) ? `@${domain}` : '@cliente.com';
  }

  protected toggleForm(): void {
    this.formOpen.update((open) => !open);
    this.editingSlug.set(null);
    this.error.set(null);
    this.created.set(null);
    this.form.reset({
      name: '',
      slug: '',
      emailDomain: '',
      adminName: '',
      adminEmail: '',
      siteName: 'Sede principal',
      siteSlug: 'local',
      modules: this.emptyModules(),
    });
    this.form.controls.slug.enable();
    this.form.controls.adminName.enable();
    this.form.controls.adminEmail.enable();
    this.form.controls.siteName.enable();
    this.form.controls.siteSlug.enable();
  }

  protected edit(item: TenantOption): void {
    if (!this.isOperator()) {
      return;
    }
    this.formOpen.set(true);
    this.editingSlug.set(item.slug);
    this.error.set(null);
    this.created.set(null);
    this.form.reset({
      name: item.name,
      slug: item.slug,
      emailDomain: item.emailDomain ?? '',
      adminName: item.users?.[0]?.displayName ?? 'Administrador',
      adminEmail: item.users?.[0]?.email ?? `admin@${item.emailDomain || 'cliente.com'}`,
      siteName: item.sites?.[0]?.name ?? 'Sede principal',
      siteSlug: item.sites?.[0]?.slug ?? 'local',
      modules: this.modulesValue(item.modules),
    });
    this.form.controls.slug.disable();
    this.form.controls.adminName.disable();
    this.form.controls.adminEmail.disable();
    this.form.controls.siteName.disable();
    this.form.controls.siteSlug.disable();
  }

  protected remove(item: TenantOption): void {
    if (!this.isOperator() || item.slug === 'default') {
      this.error.set('El tenant default no se puede eliminar.');
      return;
    }
    if (
      !window.confirm(`¿Eliminar el tenant ${item.name}? Se borrarán sitios, agentes y usuarios.`)
    ) {
      return;
    }
    this.http.delete(`${API_BASE_URL}/v1/tenants/${item.slug}?as=default`).subscribe({
      next: () => {
        if (this.editingSlug() === item.slug) {
          this.toggleForm();
          this.formOpen.set(false);
        }
        if (this.tenants.slug() === item.slug) {
          this.tenants.select('default');
        }
        this.tenants.load();
      },
      error: (err: { error?: { message?: string } }) => {
        this.error.set(err.error?.message ?? 'No se pudo eliminar el tenant.');
      },
    });
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
    const editingSlug = this.editingSlug();
    const modules = this.selectedModules();
    const request = editingSlug
      ? this.http.patch<TenantOption>(`${API_BASE_URL}/v1/tenants/${editingSlug}?as=default`, {
          name: value.name,
          emailDomain: value.emailDomain,
          modules,
        })
      : this.http.post<TenantOption>(`${API_BASE_URL}/v1/tenants?as=default`, {
          name: value.name,
          slug: value.slug || undefined,
          emailDomain: value.emailDomain,
          adminName: value.adminName,
          adminEmail: value.adminEmail,
          siteName: value.siteName,
          siteSlug: value.siteSlug || undefined,
          modules,
        });
    request.subscribe({
      next: (tenant) => {
        this.saving.set(false);
        this.form.controls.slug.enable();
        this.form.controls.adminName.enable();
        this.form.controls.adminEmail.enable();
        this.form.controls.siteName.enable();
        this.form.controls.siteSlug.enable();
        this.form.reset({
          name: '',
          slug: '',
          emailDomain: '',
          adminName: '',
          adminEmail: '',
          siteName: 'Sede principal',
          siteSlug: 'local',
          modules: this.emptyModules(),
        });
        this.formOpen.set(false);
        this.editingSlug.set(null);
        this.created.set(
          !editingSlug && tenant.temporaryPassword
            ? {
                email: tenant.users?.[0]?.email ?? value.adminEmail,
                temporaryPassword: tenant.temporaryPassword,
              }
            : null,
        );
        this.tenants.load();
      },
      error: (err: { error?: { message?: string } }) => {
        this.saving.set(false);
        this.error.set(
          err.error?.message ??
            (editingSlug ? 'No se pudo guardar el tenant.' : 'No se pudo crear el tenant.'),
        );
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

  protected modulesLabel(item: TenantOption): string {
    const ids = parseTenantModules(item.modules);
    if (!ids.length) {
      return 'Solo nucleo';
    }
    return ids
      .map((id) => this.moduleCatalog.find((entry) => entry.id === id)?.label ?? id)
      .join(', ');
  }

  private selectedModules(): OptionalTenantModule[] {
    const value = this.form.controls.modules.getRawValue();
    return this.moduleCatalog.filter((item) => value[item.id]).map((item) => item.id);
  }

  private modulesValue(modules?: string[]) {
    const enabled = new Set(parseTenantModules(modules));
    return {
      icewarp: enabled.has('icewarp'),
      sap: enabled.has('sap'),
      databases: enabled.has('databases'),
      queues: enabled.has('queues'),
      network: enabled.has('network'),
    };
  }

  private emptyModules() {
    return this.modulesValue([]);
  }
}
