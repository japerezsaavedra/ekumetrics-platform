/**
 * Series Prometheus del matching histórico (mismo estilo que CorrelationMetrics).
 */
export class HistoricalMetrics {
  private lookupsNeutral = 0;
  private lookupsMatched = 0;
  private readonly feedback = new Map<string, number>();

  recordLookup(matched: boolean): void {
    if (matched) this.lookupsMatched += 1;
    else this.lookupsNeutral += 1;
  }

  recordFeedback(action: string): void {
    this.feedback.set(action, (this.feedback.get(action) ?? 0) + 1);
  }

  render(): string {
    const lines = [
      '# HELP aiops_historical_lookups_total Consultas de evidencia histórica AIOps.',
      '# TYPE aiops_historical_lookups_total counter',
      `aiops_historical_lookups_total{outcome="neutral"} ${this.lookupsNeutral}`,
      `aiops_historical_lookups_total{outcome="matched"} ${this.lookupsMatched}`,
      '# HELP aiops_rca_feedback_total Acciones de feedback RCA del operador.',
      '# TYPE aiops_rca_feedback_total counter',
    ];
    for (const action of [
      'CONFIRM',
      'REJECT',
      'SELECT_ALTERNATIVE',
      'ADD_NOTE',
    ]) {
      lines.push(
        `aiops_rca_feedback_total{action="${action}"} ${this.feedback.get(action) ?? 0}`,
      );
    }
    lines.push(
      '# HELP aiops_feedback_total Feedback RCA persistido (vocabulario canónico).',
      '# TYPE aiops_feedback_total counter',
    );
    for (const action of [
      'CONFIRM',
      'REJECT',
      'SELECT_ALTERNATIVE',
      'ADD_NOTE',
    ]) {
      lines.push(
        `aiops_feedback_total{action="${action}"} ${this.feedback.get(action) ?? 0}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
}
