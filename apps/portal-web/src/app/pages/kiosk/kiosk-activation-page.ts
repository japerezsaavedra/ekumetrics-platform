import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { KioskService } from '../../core/kiosk';

const ROUTE_BY_DASHBOARD: Record<string, string> = {
  hosts: 'hosts',
  network: 'red',
  databases: 'bases-de-datos',
  queues: 'colas',
  icewarp: 'icewarp',
  sap: 'sap',
};

@Component({
  selector: 'app-kiosk-activation-page',
  imports: [ReactiveFormsModule],
  templateUrl: './kiosk-activation-page.html',
  styleUrl: './kiosk-activation-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KioskActivationPage {
  private readonly fb = inject(FormBuilder);
  private readonly kiosk = inject(KioskService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly saving = signal(false);
  protected readonly error = signal(
    this.route.snapshot.queryParamMap.has('invalid')
      ? 'La credencial fue revocada, expiró o dejó de ser válida.'
      : '',
  );
  protected readonly form = this.fb.nonNullable.group({
    deviceId: [
      this.route.snapshot.queryParamMap.get('id') ?? '',
      [Validators.required, Validators.minLength(16)],
    ],
    deviceSecret: ['', [Validators.required, Validators.minLength(16)]],
  });

  protected async activate(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.error.set('');
    try {
      const scope = await this.kiosk.enroll(
        this.form.controls.deviceId.value,
        this.form.controls.deviceSecret.value,
      );
      if (scope.dashboard.startsWith('custom:')) {
        await this.router.navigate(['/kiosk/board', scope.dashboard.slice('custom:'.length)]);
      } else {
        await this.router.navigate(['/kiosk', ROUTE_BY_DASHBOARD[scope.dashboard] ?? 'hosts']);
      }
    } catch {
      this.error.set('El ID o la credencial no coinciden. Use los valores de Credencial lista, no el nombre.');
    } finally {
      this.saving.set(false);
    }
  }
}
