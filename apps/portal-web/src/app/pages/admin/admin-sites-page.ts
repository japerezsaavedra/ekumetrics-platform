import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
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
  agentId: string;
  siteId: string;
  mode: string;
  yaml: string;
};

@Component({
  selector: 'app-admin-sites-page',
  imports: [ReactiveFormsModule, EkuPageHeaderComponent, EkuErrorStateComponent],
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
  protected readonly siteOpen = signal(false);
  protected readonly agentOpen = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly enrolled = signal<EnrolledAgent | null>(null);
  protected readonly siteForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2)]],
    slug: ['', [Validators.pattern(/^[a-z0-9._-]*$/)]],
  });
  protected readonly agentForm = this.fb.nonNullable.group({
    agentId: ['', [Validators.required, Validators.pattern(/^[A-Za-z0-9._-]+$/)]],
    siteId: ['local', [Validators.required, Validators.pattern(/^[A-Za-z0-9._-]+$/)]],
    mode: ['site', Validators.required],
  });

  constructor() {
    this.tenants.load();
    this.reload();
  }

  protected fieldInvalid(
    form: 'site' | 'agent',
    name: 'name' | 'slug' | 'agentId' | 'siteId',
  ): boolean {
    const control = form === 'site' ? this.siteForm.get(name) : this.agentForm.get(name);
    return !!control && control.invalid && (control.touched || control.dirty);
  }

  protected toggleSite(): void {
    this.siteOpen.update((open) => !open);
    this.agentOpen.set(false);
    this.error.set(null);
  }

  protected toggleAgent(): void {
    this.agentOpen.update((open) => !open);
    this.siteOpen.set(false);
    this.error.set(null);
    const first = this.items()[0]?.slug;
    if (first && !this.items().some((item) => item.slug === this.agentForm.controls.siteId.value)) {
      this.agentForm.controls.siteId.setValue(first);
    }
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
    this.http
      .post<TenantSite>(`${API_BASE_URL}/v1/tenants/${slug}/sites?as=${slug}`, {
        name: value.name,
        slug: value.slug || undefined,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.siteForm.reset({ name: '', slug: '' });
          this.siteOpen.set(false);
          this.reload();
        },
        error: (err: { error?: { message?: string } }) => {
          this.saving.set(false);
          this.error.set(err.error?.message ?? 'No se pudo crear el sitio.');
        },
      });
  }

  protected submitAgent(): void {
    if (this.agentForm.invalid) {
      this.agentForm.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    const slug = this.tenants.slug();
    this.http
      .post<EnrolledAgent>(`${API_BASE_URL}/v1/tenants/${slug}/agents?as=${slug}`, this.agentForm.getRawValue())
      .subscribe({
        next: (value) => {
          this.saving.set(false);
          this.enrolled.set(value);
          this.agentOpen.set(false);
          this.reload();
        },
        error: (err: { error?: { message?: string } }) => {
          this.saving.set(false);
          this.error.set(err.error?.message ?? 'No se pudo agregar el agente.');
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
  }
}
