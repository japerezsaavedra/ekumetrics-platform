export const AGENT_FINDING_STATUSES = [
  'PENDING',
  'RUNNING',
  'WAITING',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'TIMEOUT',
] as const;

export type AgentFindingStatus = (typeof AGENT_FINDING_STATUSES)[number];

export const TERMINAL_FINDING_STATUSES: readonly AgentFindingStatus[] = [
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'TIMEOUT',
];

const FINDING_TRANSITIONS: Record<
  AgentFindingStatus,
  readonly AgentFindingStatus[]
> = {
  PENDING: ['RUNNING', 'SKIPPED'],
  RUNNING: ['WAITING', 'COMPLETED', 'FAILED', 'TIMEOUT'],
  WAITING: ['RUNNING', 'FAILED', 'TIMEOUT'],
  COMPLETED: [],
  FAILED: [],
  SKIPPED: [],
  TIMEOUT: [],
};

export type AgentFindingEvidenceItem = {
  kind: string;
  summary: string;
  entityKey?: string;
  sourceRef?: string;
  facts?: Record<string, unknown>;
};

/**
 * Resultado de un AIOps Agent. Persistido (tabla AgentFinding).
 * agentType es Rca|Metrics|Logs|… — nunca el recolector Ekumetrics Agent.
 */
export type AgentFinding = {
  id: string;
  tenantId: string;
  incidentId: string;
  investigationId?: string;
  agentType: string;
  status: AgentFindingStatus;
  summary: string;
  evidence: AgentFindingEvidenceItem[];
  confidence?: number;
  startedAt?: Date;
  completedAt?: Date;
  provider?: string;
  model?: string;
  toolCalls?: unknown[];
  errors?: unknown[];
  skipReason?: string;
  plan?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};

export function canTransitionFindingStatus(
  from: AgentFindingStatus,
  to: AgentFindingStatus,
): boolean {
  return FINDING_TRANSITIONS[from].includes(to);
}

export function isTerminalFindingStatus(status: AgentFindingStatus): boolean {
  return TERMINAL_FINDING_STATUSES.includes(status);
}

export function assertFindingTransition(
  from: AgentFindingStatus,
  to: AgentFindingStatus,
): void {
  if (!canTransitionFindingStatus(from, to)) {
    throw new Error(
      `Transición de AgentFinding no permitida: ${from} -> ${to}`,
    );
  }
}
