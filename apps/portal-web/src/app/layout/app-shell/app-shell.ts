import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatSidenav, MatSidenavContainer, MatSidenavContent } from '@angular/material/sidenav';
import { MatToolbar } from '@angular/material/toolbar';
import { MatTooltip } from '@angular/material/tooltip';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { AuthService } from '../../core/auth';
import { KioskService } from '../../core/kiosk';
import { TenantService } from '../../core/tenant';
import { ThemeService } from '../../core/theme';
import { NAV_ITEMS, navGroupOpenByDefault, type NavItem } from '../nav';

@Component({
  selector: 'app-shell',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    MatSidenavContainer,
    MatSidenav,
    MatSidenavContent,
    MatToolbar,
    MatIcon,
    MatIconButton,
    MatTooltip,
    ReactiveFormsModule,
  ],
  templateUrl: './app-shell.html',
  styleUrl: './app-shell.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppShell {
  private readonly theme = inject(ThemeService);
  private readonly kiosk = inject(KioskService);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly tenants = inject(TenantService);
  protected readonly tenantOptions = this.tenants.tenants;
  protected readonly isOperator = this.tenants.isOperator;
  protected readonly userEmail = this.auth.email;
  protected readonly userName = this.auth.name;
  protected readonly tenantControl = new FormControl(this.tenants.slug(), { nonNullable: true });
  protected readonly asideOpen = signal(true);
  protected readonly kioskOn = this.kiosk.active;
  protected readonly nav = computed(() => {
    const operator = this.tenants.isOperator();
    const role = this.auth.role();
    const modules = new Set(this.tenants.enabledModules());
    return NAV_ITEMS.filter(
      (item) =>
        (!item.operatorOnly || operator) &&
        (!item.roles || item.roles.includes(role)) &&
        (!item.module || modules.has(item.module)),
    ).map((item) => ({
      ...item,
      children: item.children?.filter(
        (child) =>
          (!child.operatorOnly || operator) && (!child.roles || child.roles.includes(role)),
      ),
    }));
  });
  protected readonly openGroups = signal<Record<string, boolean>>(
    navGroupOpenByDefault(this.router.url),
  );
  private readonly path = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  protected isDark(): boolean {
    return this.theme.mode() === 'dark';
  }

  protected toggleTheme(): void {
    this.theme.toggle();
  }

  protected logout(): void {
    void this.auth.logout();
  }

  protected isLogin(): boolean {
    const url = this.currentUrl();
    return (
      url.startsWith('/login') ||
      url.startsWith('/enrolar-mfa') ||
      url.startsWith('/kiosk/activar')
    );
  }

  protected currentUrl(): string {
    return this.path() || this.router.url || '/';
  }

  protected showAssistantFab(): boolean {
    return !this.kioskOn() && !this.currentUrl().startsWith('/asistente');
  }

  constructor() {
    this.tenants.load();
    this.tenantControl.valueChanges.subscribe((slug) => this.tenants.select(slug));
    effect(() => {
      const slug = this.tenants.slug();
      if (slug !== this.tenantControl.value) {
        this.tenantControl.setValue(slug, { emitEvent: false });
      }
    });
    effect(() => {
      const url = this.currentUrl();
      if (this.kioskOn()) {
        this.asideOpen.set(false);
      }
      if (this.kioskOn() && !this.isMonitorPath(url)) {
        this.kiosk.exit();
      }
      untracked(() => this.openActiveGroup(url));
    });
  }

  protected toggleGroup(id: string): void {
    this.openGroups.update((current) => ({ ...current, [id]: !current[id] }));
  }

  protected isGroupOpen(id: string): boolean {
    return !!this.openGroups()[id];
  }

  protected isGroupActive(item: NavItem): boolean {
    const url = this.currentUrl();
    return (item.children ?? []).some(
      (child) => url === child.path || url.startsWith(`${child.path}/`),
    );
  }

  private openActiveGroup(url: string): void {
    const next = { ...this.openGroups() };
    for (const item of this.nav()) {
      if (item.children?.some((child) => url === child.path || url.startsWith(`${child.path}/`))) {
        next[item.id] = true;
      }
    }
    this.openGroups.set(next);
  }

  private isMonitorPath(url: string): boolean {
    return (
      url === '/' ||
      url.startsWith('/hosts') ||
      url.startsWith('/red') ||
      url.startsWith('/agentes') ||
      url.startsWith('/logs') ||
      url.startsWith('/bases-de-datos') ||
      url.startsWith('/colas') ||
      url.startsWith('/icewarp') ||
      url.startsWith('/sap') ||
      url.startsWith('/kiosk/')
    );
  }
}
