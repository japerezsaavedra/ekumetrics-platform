import type { BlastRadius } from './topology-impact';

export const INCIDENT_PRIORITY_CALCULATOR = 'IncidentPriorityCalculator';

export const INCIDENT_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;

export type IncidentPriority = (typeof INCIDENT_PRIORITIES)[number];

export type IncidentPriorityInput = {
  tenantId: string;
  incidentId: string;
  severity?: string;
  rcaConfidence?: number;
  affectedServiceCount?: number;
  blastRadius?: BlastRadius;
};

export interface IncidentPriorityCalculator {
  calculate(input: IncidentPriorityInput): IncidentPriority;
}
