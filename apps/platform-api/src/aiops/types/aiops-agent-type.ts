/**
 * Tipos de AIOps Agent (investigador lógico de plataforma).
 * No confundir con el recolector Ekumetrics Agent (Prisma `Agent` / collectorId).
 */
export const AIOPS_AGENT_TYPES = [
  'Rca',
  'Metrics',
  'Logs',
  'Kubernetes',
  'Topology',
  'Synthesis',
] as const;

export type AiopsAgentType = (typeof AIOPS_AGENT_TYPES)[number];

/** Reservados Wave 3: interfaz compilable, select nunca los elige. */
export const FUTURE_AIOPS_AGENT_TYPES = [
  'Network',
  'Database',
  'Application',
  'Change',
  'Security',
  'Capacity',
  'Remediation',
] as const;

export type FutureAiopsAgentType = (typeof FUTURE_AIOPS_AGENT_TYPES)[number];

export function isAiopsAgentType(value: string): value is AiopsAgentType {
  return (AIOPS_AGENT_TYPES as readonly string[]).includes(value);
}

export function isFutureAiopsAgentType(
  value: string,
): value is FutureAiopsAgentType {
  return (FUTURE_AIOPS_AGENT_TYPES as readonly string[]).includes(value);
}
