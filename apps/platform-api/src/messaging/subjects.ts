/**
 * Único sitio con strings de subjects de dominio.
 * El resto del código importa estas constantes; no hardcodear subjects.
 */
export const EventSubjects = {
  EVENTS_INGESTED: 'ekumetrics.events.ingested',
  EVENTS_CORRELATED: 'ekumetrics.events.correlated',
  TOPOLOGY_UPDATED: 'ekumetrics.topology.updated',
  ANOMALIES_DETECTED: 'ekumetrics.anomalies.detected',
  INCIDENTS_CREATED: 'ekumetrics.incidents.created',
  INCIDENTS_UPDATED: 'ekumetrics.incidents.updated',
  INCIDENTS_RESOLVED: 'ekumetrics.incidents.resolved',
  INCIDENTS_ENRICHMENT_REQUESTED: 'ekumetrics.incidents.enrichment.requested',
  INCIDENTS_ENRICHED: 'ekumetrics.incidents.enriched',
  RCA_REQUESTED: 'ekumetrics.rca.requested',
  RCA_COMPLETED: 'ekumetrics.rca.completed',
  AIOPS_INVESTIGATION_REQUESTED: 'ekumetrics.aiops.investigation.requested',
  AIOPS_INVESTIGATION_STARTED: 'ekumetrics.aiops.investigation.started',
  AIOPS_INVESTIGATION_COMPLETED: 'ekumetrics.aiops.investigation.completed',
  AIOPS_INVESTIGATION_FAILED: 'ekumetrics.aiops.investigation.failed',
  AIOPS_AGENT_STARTED: 'ekumetrics.aiops.agent.started',
  AIOPS_AGENT_COMPLETED: 'ekumetrics.aiops.agent.completed',
} as const;

export type EventSubject = (typeof EventSubjects)[keyof typeof EventSubjects];

export const EVENT_SUBJECT_VALUES: readonly EventSubject[] =
  Object.values(EventSubjects);

export const DLQ_PREFIX = 'ekumetrics.dlq' as const;

export function toDeadLetterSubject(subject: string): string {
  if (subject.startsWith(`${DLQ_PREFIX}.`)) {
    return subject;
  }
  return `${DLQ_PREFIX}.${subject}`;
}

export function isEkumetricsSubject(subject: string): boolean {
  return subject.startsWith('ekumetrics.') && !subject.includes(' ');
}
