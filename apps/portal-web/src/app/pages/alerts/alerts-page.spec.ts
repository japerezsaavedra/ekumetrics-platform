import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AlertsPage } from './alerts-page';

describe('AlertsPage', () => {
  it('consulta el BFF y presenta las alertas de Alertmanager', async () => {
    TestBed.configureTestingModule({
      imports: [AlertsPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(AlertsPage);

    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.expectOne('http://localhost:3000/v1/alerts').flush({
      alerts: [
        {
          annotations: {
            summary: 'El filesystem tiene menos de 5 % libre',
            impact: 'Existe riesgo inmediato de rechazo de ingesta.',
          },
          endsAt: null,
          fingerprint: 'alert-1',
          generatorUrl: '',
          inhibitedBy: [],
          labels: { alertname: 'DiskCapacityCritical', severity: 'critical' },
          name: 'DiskCapacityCritical',
          severity: 'critical',
          silencedBy: [],
          startsAt: '2026-08-27T01:00:00.000Z',
          state: 'active',
          updatedAt: '2026-08-27T01:00:00.000Z',
        },
      ],
      silences: [],
      updatedAt: '2026-08-27T01:00:00.000Z',
    });
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('DiskCapacityCritical');
    expect(text).toContain('Críticas');
    expect(text).toContain('Existe riesgo inmediato');

    http.verify();
    fixture.destroy();
  });
});
