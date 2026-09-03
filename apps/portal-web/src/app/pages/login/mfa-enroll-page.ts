import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth';
import { ThemeService } from '../../core/theme';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';

@Component({
  selector: 'app-mfa-enroll-page',
  imports: [MatIcon, ReactiveFormsModule, EkuErrorStateComponent],
  templateUrl: './mfa-enroll-page.html',
  styleUrl: './login-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MfaEnrollPage {
  private readonly auth = inject(AuthService);
  private readonly theme = inject(ThemeService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly fb = inject(FormBuilder);
  protected readonly submitting = signal(false);
  protected readonly submitted = signal(false);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly qrDataUrl = signal('');
  protected readonly secret = signal('');
  protected readonly form = this.fb.nonNullable.group({
    totp: ['', [Validators.required, Validators.pattern(/^\d{6}$/)]],
  });

  constructor() {
    if (!this.auth.authenticated()) {
      void this.router.navigateByUrl('/login');
      return;
    }
    if (!this.auth.mfaEnrollmentRequired()) {
      void this.router.navigateByUrl(this.redirect());
      return;
    }
    void this.loadSetup();
  }

  protected isDark(): boolean {
    return this.theme.mode() === 'dark';
  }

  protected toggleTheme(): void {
    this.theme.toggle();
  }

  protected fieldInvalid(): boolean {
    const control = this.form.controls.totp;
    return control.invalid && (control.touched || this.submitted());
  }

  protected async confirm(): Promise<void> {
    this.submitted.set(true);
    this.error.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    try {
      await this.auth.confirmMfa(this.form.controls.totp.value);
      await this.router.navigateByUrl(this.redirect());
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'No se pudo confirmar el MFA.');
      this.submitting.set(false);
    }
  }

  private async loadSetup(): Promise<void> {
    try {
      const setup = await this.auth.beginMfaSetup();
      this.qrDataUrl.set(setup.qrDataUrl);
      this.secret.set(setup.secret);
      this.error.set(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'No se pudo generar el código MFA.');
    } finally {
      this.loading.set(false);
    }
  }

  private redirect(): string {
    const value = this.route.snapshot.queryParamMap.get('redirect') || '/hosts';
    if (value.startsWith('/enrolar-mfa')) return '/hosts';
    return value.startsWith('/') && !value.startsWith('//') ? value : '/hosts';
  }
}
