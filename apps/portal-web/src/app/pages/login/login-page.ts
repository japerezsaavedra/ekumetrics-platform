import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth';
import { ThemeService } from '../../core/theme';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { differentFrom, passwordMatch } from '../../validators/password-match';

@Component({
  selector: 'app-login-page',
  imports: [ReactiveFormsModule, MatIcon, EkuErrorStateComponent],
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
  protected readonly mustChange = signal(false);
  protected readonly error = signal<string | null>(this.auth.error());
  protected readonly form = this.fb.nonNullable.group({
    email: ['operator@gradotech.com', [Validators.required, Validators.email]],
    password: ['ekumetrics', [Validators.required, Validators.minLength(1)]],
  });
  protected readonly changeForm = this.fb.nonNullable.group(
    {
      currentPassword: [''],
      newPassword: ['', [Validators.required, Validators.minLength(8), differentFrom('currentPassword')]],
      confirmPassword: ['', [Validators.required]],
    },
    { validators: passwordMatch('newPassword', 'confirmPassword') },
  );

  constructor() {
    if (this.auth.authenticated()) {
      void this.router.navigateByUrl(this.redirect());
    }
  }

  protected isDark(): boolean {
    return this.theme.mode() === 'dark';
  }

  protected toggleTheme(): void {
    this.theme.toggle();
  }

  protected fieldInvalid(name: 'email' | 'password'): boolean {
    const control = this.form.controls[name];
    return control.invalid && (control.touched || control.dirty);
  }

  protected fieldHint(name: 'email' | 'password'): string {
    if (!this.fieldInvalid(name)) {
      return '';
    }
    return name === 'email' ? 'Ingrese un correo electrónico válido.' : 'Ingrese su contraseña.';
  }

  protected changeInvalid(name: 'newPassword' | 'confirmPassword'): boolean {
    const control = this.changeForm.controls[name];
    return (control.invalid || this.changeForm.hasError('passwordMatch')) && (control.touched || control.dirty);
  }

  protected changeHint(name: 'newPassword' | 'confirmPassword'): string {
    const control = this.changeForm.controls[name];
    if (!this.changeInvalid(name)) {
      return '';
    }
    if (name === 'newPassword' && control.hasError('minlength')) {
      return 'La contraseña debe tener al menos 8 caracteres.';
    }
    if (name === 'newPassword' && control.hasError('samePassword')) {
      return 'La nueva contraseña debe ser distinta a la temporal.';
    }
    if (name === 'confirmPassword' || this.changeForm.hasError('passwordMatch')) {
      return 'Las contraseñas no coinciden.';
    }
    return 'Ingrese la nueva contraseña.';
  }

  protected async enter(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.error.set(null);
    try {
      const { email, password } = this.form.getRawValue();
      const result = await this.auth.signIn(email, password);
      if (result === 'change-password') {
        this.changeForm.controls.currentPassword.setValue(password);
        this.mustChange.set(true);
        this.submitting.set(false);
        return;
      }
      window.location.assign(this.redirect());
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Las credenciales no son válidas.');
      this.submitting.set(false);
    }
  }

  protected async savePassword(): Promise<void> {
    if (this.changeForm.invalid) {
      this.changeForm.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.error.set(null);
    try {
      const { email, password } = this.form.getRawValue();
      const { newPassword, confirmPassword } = this.changeForm.getRawValue();
      await this.auth.completeFirstPassword(email, password, newPassword, confirmPassword);
      window.location.assign(this.redirect());
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'No fue posible actualizar la contraseña.');
      this.submitting.set(false);
    }
  }

  private redirect(): string {
    const value = this.route.snapshot.queryParamMap.get('redirect') || '/hosts';
    return value.startsWith('/') ? value : `/${value}`;
  }
}
