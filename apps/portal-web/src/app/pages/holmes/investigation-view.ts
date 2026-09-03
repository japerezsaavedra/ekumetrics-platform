import type {
  ChatEvidence,
  InvestigationSourceState,
  InvestigationSummary,
} from './conversation-store';

export type InvestigationSourceView = {
  source: ChatEvidence['source'];
  state: InvestigationSourceState;
};

const SOURCE_ORDER: ChatEvidence['source'][] = [
  'prometheus',
  'loki',
  'tempo',
  'postgresql',
  'inventory',
  'knowledge',
];

export function investigationSources(
  investigation: InvestigationSummary,
): InvestigationSourceView[] {
  return SOURCE_ORDER.map((source) => ({
    source,
    state: investigation.sources[source] ?? 'not_requested',
  })).filter((item) => item.state !== 'not_requested');
}

export function sourceStateLabel(state: InvestigationSourceState): string {
  return {
    available: 'Con evidencia',
    no_data: 'Sin datos',
    unavailable: 'No disponible',
    not_requested: 'No solicitada',
  }[state];
}

export function outcomeLabel(outcome: InvestigationSummary['outcome']): string {
  return {
    normal: 'Valores dentro de rango',
    attention: 'Requiere atención',
    no_data: 'Sin datos medidos',
  }[outcome];
}

export function confidenceLabel(level: InvestigationSummary['confidence']['level']): string {
  return { high: 'Alta', medium: 'Media', low: 'Baja' }[level];
}
