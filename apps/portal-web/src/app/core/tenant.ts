import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { API_BASE_URL } from './api';
import { AuthService } from './auth';

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
  temporaryPassword?: string;
};

@Injectable({ providedIn: 'root' })
export class TenantService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  readonly tenants = signal<TenantOption[]>([]);
  readonly slug = signal(this.readSlug());
  readonly current = computed(
    () => this.tenants().find((item) => item.slug === this.slug()) ?? this.tenants()[0] ?? null,
  );
  readonly isOperator = this.auth.isOperator;

  constructor() {
    effect(() => {
      if (!this.auth.authenticated()) {
        return;
      }
      if (!this.auth.isOperator()) {
        this.select(this.auth.tenant());
      } else if (!this.slug()) {
        this.select(this.auth.tenant());
      }
    });
  }

  load(): void {
    if (!this.auth.authenticated()) {
      return;
    }
    this.http.get<TenantOption[]>(`${API_BASE_URL}/v1/tenants`).subscribe({
      next: (items) => {
        this.tenants.set(items);
        const stored = this.slug() || this.readSlug();
        if (stored && items.some((item) => item.slug === stored)) {
          if (stored !== this.slug()) {
            this.select(stored);
          }
          return;
        }
        if (!stored) {
          this.select(this.auth.tenant() || items[0]?.slug || 'default');
        }
      },
    });
  }

  select(slug: string): void {
    const next = slug.trim() || this.auth.tenant() || this.readSlug() || 'default';
    this.slug.set(next);
    if (this.auth.isOperator()) {
      localStorage.setItem(STORAGE_KEY, next);
    }
  }

  private readSlug(): string {
    return localStorage.getItem(STORAGE_KEY) || '';
  }
}
