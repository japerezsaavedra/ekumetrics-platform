import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { API_BASE_URL } from '../../core/api';

type HealthStatus = {
  status: string;
  service: string;
};

@Component({
  selector: 'app-home-page',
  templateUrl: './home-page.html',
  styleUrl: './home-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomePage {
  private readonly http = inject(HttpClient);

  protected readonly apiUrl = API_BASE_URL;
  protected readonly health = signal<HealthStatus | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.http.get<HealthStatus>(`${API_BASE_URL}/health`).subscribe({
      next: (value) => {
        this.health.set(value);
        this.error.set(null);
      },
      error: () => {
        this.health.set(null);
        this.error.set('La API no responde. Inicie platform-api en el puerto 3000.');
      },
    });
  }
}
