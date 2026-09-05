import { describe, expect, it } from 'vitest';
import {
  agentTypeLabel,
  enrichmentPriority,
  investigationStatusLabel,
  rcaModeLabel,
  rcaPercent,
} from './incident-enrichment.view';

describe('incident enrichment view', () => {
  it('muestra estado vacio cuando no hay datos Wave 2', () => {
    expect(enrichmentPriority(null)).toBeNull();
    expect(enrichmentPriority(undefined)).toBeNull();
    expect(rcaPercent(null)).toBe('Sin RCA');
  });

  it('formatea prioridad y confianza RCA', () => {
    expect(
      enrichmentPriority({
        algorithm: 'deterministic_enrichment_v1',
        source: 'aiops.enrichment',
        score: 0.8,
        confidence: 0.8,
        rcaConfidence: 0.85,
        computedPriority: {
          level: 'P1',
          score: 0.8,
          confidence: 0.8,
          algorithm: 'weighted_priority_v1',
          source: 'IncidentPriorityCalculator',
        },
      }),
    ).toBe('P1');
    expect(rcaPercent(0.85)).toBe('85 %');
    expect(rcaModeLabel({ rcaMode: 'deterministic_engine' } as never)).toContain(
      'RcaEngine',
    );
  });

  it('etiqueta estados de investigacion Wave 3 y AIOps Agents', () => {
    expect(investigationStatusLabel('PENDING')).toBe('Pendiente');
    expect(investigationStatusLabel('QUEUED')).toBe('Pendiente');
    expect(investigationStatusLabel('SYNTHESIZING')).toBe('En curso');
    expect(investigationStatusLabel('PARTIAL')).toBe('Parcial');
    expect(agentTypeLabel('Metrics')).toBe('Métricas');
    expect(agentTypeLabel('Kubernetes')).toBe('Kubernetes');
  });
});
