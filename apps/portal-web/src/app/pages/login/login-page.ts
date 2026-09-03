import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth';
import { ThemeService } from '../../core/theme';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';

@Component({
  selector: 'app-login-page',
  imports: [MatIcon, ReactiveFormsModule, EkuErrorStateComponent],
  templateUrl: './login-page.html',
  styleUrl: './login-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly theme = inject(ThemeService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly fb = inject(FormBuilder);
  protected readonly submitting = signal(false);
  protected readonly submitted = signal(false);
  protected readonly error = signal<string | null>(this.auth.error());
  protected readonly mfaRequired = signal(false);
  protected readonly totpEnrolled = signal(false);
  protected readonly entraEnabled = signal(false);
  protected readonly adEnabled = signal(false);
  protected readonly form = this.fb.nonNullable.group({
    email: ['operator@gradotech.com', [Validators.required, Validators.email]],
    password: ['ekumetrics-local', [Validators.required]],
    totp: [''],
  });

  constructor() {
    if (this.auth.authenticated()) {
      void this.router.navigateByUrl(
        this.auth.mfaEnrollmentRequired() ? '/enrolar-mfa' : this.redirect(),
      );
    }
    this.form.controls.email.valueChanges.subscribe((email) => {
      void this.refreshOptions(email);
    });
    void this.refreshOptions(this.form.controls.email.value);
  }

  protected isDark(): boolean {
    return this.theme.mode() === 'dark';
  }

  protected toggleTheme(): void {
    this.theme.toggle();
  }

  protected fieldInvalid(name: 'email' | 'password' | 'totp'): boolean {
    const control = this.form.controls[name];
    return control.invalid && (control.touched || this.submitted());
  }

  protected async enter(): Promise<void> {
    this.submitted.set(true);
    this.error.set(null);
    this.syncTotpValidator();
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    try {
      const { email, password, totp } = this.form.getRawValue();
      const destination = await this.auth.beginLogin(email, password, this.redirect(), totp);
      await this.router.navigateByUrl(destination);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'No fue posible iniciar sesión.');
      this.submitting.set(false);
    }
  }

  protected continueEntra(): void {
    const email = this.form.controls.email.value;
    if (this.form.controls.email.invalid) {
      this.form.controls.email.markAsTouched();
      return;
    }
    this.auth.beginBroker(email, this.redirect());
  }

  private async refreshOptions(email: string): Promise<void> {
    if (this.form.controls.email.invalid) {
      this.mfaRequired.set(false);
      this.totpEnrolled.set(false);
      this.entraEnabled.set(false);
      this.adEnabled.set(false);
      this.syncTotpValidator();
      return;
    }
    try {
      const options = await this.auth.loginOptions(email);
      this.mfaRequired.set(options.mfaRequired);
      this.totpEnrolled.set(options.totpEnrolled);
      this.entraEnabled.set(options.entraEnabled);
      this.adEnabled.set(options.adEnabled);
    } catch {
      this.mfaRequired.set(false);
      this.totpEnrolled.set(false);
      this.entraEnabled.set(false);
      this.adEnabled.set(false);
    }
    this.syncTotpValidator();
  }

  private syncTotpValidator(): void {
    this.form.controls.totp.setValidators(
      this.mfaRequired() && this.totpEnrolled() ? [Validators.required] : [],
    );
    this.form.controls.totp.updateValueAndValidity({ emitEvent: false });
  }

  private redirect(): string {
    const value = this.route.snapshot.queryParamMap.get('redirect') || '/hosts';
    return value.startsWith('/') ? value : `/${value}`;
  }
}
