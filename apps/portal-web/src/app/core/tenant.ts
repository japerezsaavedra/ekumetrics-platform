import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { API_BASE_URL } from './api';

const STORAGE_KEY = 'eku-tenant';

export type TenantSite = {
  id: string;
  slug: string;
  name: string;
};

export type TenantOption = {
  id: string;
  slug: string;
  name: string;
  emailDomain?: string | null;
  _count?: { agents: number; users: number; sites: number };
  users?: Array<{ email: string; displayName: string; role: string }>;
  sites?: TenantSite[];
};

@Injectable({ providedIn: 'root' })
export class TenantService {
  private readonly http = inject(HttpClient);
  readonly tenants = signal<TenantOption[]>([]);
  readonly slug = signal(this.readSlug());
  readonly current = computed(
    () => this.tenants().find((item) => item.slug === this.slug()) ?? this.tenants()[0] ?? null,
  );
  readonly isOperator = computed(() => this.slug() === 'default');

  load(): void {
    this.http.get<TenantOption[]>(`${API_BASE_URL}/v1/tenants?as=${this.slug() || 'default'}`).subscribe({
      next: (items) => {
        this.tenants.set(items);
        if (!items.some((item) => item.slug === this.slug())) {
          this.select(items[0]?.slug || 'default');
        }
      },
    });
  }

  select(slug: string): void {
    const next = slug.trim() || 'default';
    this.slug.set(next);
    localStorage.setItem(STORAGE_KEY, next);
  }

  private readSlug(): string {
    return localStorage.getItem(STORAGE_KEY) || 'default';
  }
}
