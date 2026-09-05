import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TenantService } from '../../core/tenant';
import { IncidentsPage } from './incidents-page';

describe('IncidentsPage', () => {
  it('conserva el listado Wave 1 y muestra empty state de enrichment', async () => {
    TestBed.configureTestingModule({
      imports: [IncidentsPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: TenantService,
          useValue: { slug: signal('cliente-a') },
        },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(IncidentsPage);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.expectOne('http://localhost:3000/v1/incidents').flush([
      {
        id: 'inc-1',
        title: 'Degradación de conectividad · Core switch',
        status: 'open',
        severity: 'warning',
        siteId: 'santiago',
        causeName: 'Core switch',
        causeKey: 'sw-core',
        confidence: 0.85,
        alertCount: 2,
        eventCount: 2,
        windowStart: '2026-09-05T10:31:00.000Z',
        windowEnd: '2026-09-05T10:32:00.000Z',
        members: {
          alerts: [{ fingerprint: 'fp-a', name: 'API latency', severity: 'warning' }],
          impact: ['api-pagos'],
        },
        enrichment: null,
        createdAt: '2026-09-05T10:31:00.000Z',
        updatedAt: '2026-09-05T10:32:00.000Z',
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    http
      .expectOne('http://localhost:3000/v1/incidents/inc-1/investigation')
      .flush({ investigation: null });
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Degradación de conectividad · Core switch');
    expect(text).toContain('Core switch');
    expect(text).toContain('Sin enriquecimiento RCA');
    http.verify();
    fixture.destroy();
  });

  it('pinta timeline, RCA y radio cuando hay enrichment', async () => {
    TestBed.configureTestingModule({
      imports: [IncidentsPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: TenantService,
          useValue: { slug: signal('cliente-a') },
        },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(IncidentsPage);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.expectOne('http://localhost:3000/v1/incidents').flush([
      {
        id: 'inc-1',
        title: 'Degradación',
        status: 'open',
        severity: 'critical',
        siteId: null,
        causeName: 'Core switch',
        causeKey: 'sw-core',
        confidence: 0.85,
        alertCount: 1,
        eventCount: 1,
        windowStart: null,
        windowEnd: null,
        members: { alerts: [], impact: [] },
        enrichment: {
          algorithm: 'deterministic_enrichment_v1',
          source: 'aiops.enrichment',
          score: 0.8,
          confidence: 0.85,
          rcaConfidence: 0.85,
          computedPriority: {
            level: 'P1',
            score: 0.8,
            confidence: 0.8,
            algorithm: 'weighted_priority_v1',
            source: 'IncidentPriorityCalculator',
          },
          anomalies: [
            {
              id: 'a1',
              summary: 'DB latency anomaly',
              kind: 'latency',
              occurredAt: '2026-09-05T10:31:02.000Z',
            },
          ],
          rootCauseCandidates: [
            {
              id: 'rcc-1',
              rank: 1,
              hypothesis: 'Core switch',
              confidence: 0.85,
              score: 0.85,
              status: 'PROPOSED',
              source: 'deterministic_rca',
              algorithm: 'common_cover_cache',
            },
          ],
          primaryRootCause: {
            id: 'rcc-1',
            rank: 1,
            hypothesis: 'Core switch',
            confidence: 0.85,
            score: 0.85,
            status: 'PROPOSED',
            source: 'deterministic_rca',
            algorithm: 'common_cover_cache',
          },
          correlationEvidence: [
            {
              kind: 'temporal',
              statement: 'ventana temporal 53 segundos',
              score: 0.8,
              confidence: 0.75,
              algorithm: 'correlation_v2_members',
              source: 'incident.members.correlation',
            },
          ],
          blastRadius: { originKey: 'sw-core', hops: 3, entityCount: 4, entityKeys: ['sw-core'] },
          timeline: [
            {
              occurredAt: '2026-09-05T10:31:02.000Z',
              sequence: 1,
              summary: 'DB latency anomaly',
              kind: 'anomaly',
            },
          ],
        },
        createdAt: '2026-09-05T10:31:00.000Z',
        updatedAt: '2026-09-05T10:32:00.000Z',
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    http
      .expectOne('http://localhost:3000/v1/incidents/inc-1/investigation')
      .flush({ investigation: null });
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('P1');
    expect(text).toContain('DB latency anomaly');
    expect(text).toContain('Core switch');
    expect(text).toContain('ventana temporal 53 segundos');
    expect(text).toContain('4 entidades');
    expect(text).toContain('Investigación IA');
    expect(text).toContain('No ejecutada');
    expect(text).toContain('RCA determinista');
    http.verify();
    fixture.destroy();
  });
});
