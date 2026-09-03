import { describe, expect, it } from 'vitest';
import type { InvestigationSummary } from './conversation-store';
import {
  confidenceLabel,
  investigationSources,
  outcomeLabel,
  sourceStateLabel,
} from './investigation-view';

const investigation: InvestigationSummary = {
  window: { start: '2026-08-26T10:00:00.000Z', end: '2026-08-26T11:00:00.000Z' },
  entities: { agents: ['agent-a'], sites: ['site-a'] },
  sources: {
    prometheus: 'available',
    loki: 'no_data',
    tempo: 'unavailable',
    postgresql: 'not_requested',
    inventory: 'not_requested',
    knowledge: 'not_requested',
  },
  confidence: { level: 'low', score: 0.53, reason: 'Tempo no disponible.' },
  outcome: 'attention',
};

describe('investigation view', () => {
  it('expone solo fuentes solicitadas en un orden estable', () => {
    expect(investigationSources(investigation)).toEqual([
      { source: 'prometheus', state: 'available' },
      { source: 'loki', state: 'no_data' },
      { source: 'tempo', state: 'unavailable' },
    ]);
  });

  it('diferencia normalidad, ausencia de datos y fuentes no disponibles', () => {
    expect(outcomeLabel('normal')).toBe('Valores dentro de rango');
    expect(outcomeLabel('no_data')).toBe('Sin datos medidos');
    expect(sourceStateLabel('no_data')).toBe('Sin datos');
    expect(sourceStateLabel('unavailable')).toBe('No disponible');
    expect(confidenceLabel('low')).toBe('Baja');
  });
});
