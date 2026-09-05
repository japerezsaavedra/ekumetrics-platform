/**
 * Lifecycle AIOps. Convive con Incident.status (open|acknowledged|resolved|closed).
 * No se escribe en Incident: el mapeo es de solo lectura / campo opcional
 * en AiopsInvestigation.incidentLifecycle.
 */
export const INCIDENT_LIFECYCLES = [
  'DETECTED',
  'CORRELATING',
  'INVESTIGATING',
  'ROOT_CAUSE_IDENTIFIED',
  'MITIGATING',
  'RESOLVED',
  'CLOSED',
] as const;

export type IncidentLifecycle = (typeof INCIDENT_LIFECYCLES)[number];

export const INCIDENT_STATUSES = [
  'open',
  'acknowledged',
  'resolved',
  'closed',
] as const;

export type IncidentStatusLegacy = (typeof INCIDENT_STATUSES)[number];

/** Mapeo informativo: no muta Incident.status. */
export const INCIDENT_STATUS_TO_LIFECYCLE: Record<
  IncidentStatusLegacy,
  IncidentLifecycle
> = {
  open: 'DETECTED',
  acknowledged: 'INVESTIGATING',
  resolved: 'RESOLVED',
  closed: 'CLOSED',
};

export function mapIncidentStatusToLifecycle(
  status: IncidentStatusLegacy,
): IncidentLifecycle {
  return INCIDENT_STATUS_TO_LIFECYCLE[status];
}

/** Inverso informativo. No escribe Incident.status. */
export function mapLifecycleToIncidentStatus(
  lifecycle: IncidentLifecycle,
): IncidentStatusLegacy {
  if (lifecycle === 'RESOLVED') return 'resolved';
  if (lifecycle === 'CLOSED') return 'closed';
  if (lifecycle === 'ROOT_CAUSE_IDENTIFIED' || lifecycle === 'MITIGATING') {
    return 'acknowledged';
  }
  return 'open';
}
