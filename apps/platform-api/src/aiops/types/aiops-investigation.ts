import type { AiopsAgentType } from './aiops-agent-type';
import type { IncidentLifecycle } from './incident-lifecycle';
import type { InvestigationResult } from './investigation-result';

export const AIOPS_INVESTIGATION_STATUSES = [
  'QUEUED',
  'PENDING',
  'RUNNING',
  'SYNTHESIZING',
  'PARTIAL',
  'COMPLETED',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
  'BUDGET_EXCEEDED',
] as const;

export type AiopsInvestigationStatus =
  (typeof AIOPS_INVESTIGATION_STATUSES)[number];

/** Estados de producto Wave 3. QUEUED se lee como PENDING; SYNTHESIZING como RUNNING. */
export const PRODUCT_INVESTIGATION_STATUSES = [
  'PENDING',
  'RUNNING',
  'PARTIAL',
  'COMPLETED',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
] as const;

export type ProductInvestigationStatus =
  (typeof PRODUCT_INVESTIGATION_STATUSES)[number];

export const ACTIVE_INVESTIGATION_STATUSES: readonly AiopsInvestigationStatus[] =
  ['QUEUED', 'PENDING', 'RUNNING', 'SYNTHESIZING'];

export const AIOPS_INVESTIGATION_TRIGGERS = [
  'auto',
  'operator',
  'reopen',
] as const;

export type AiopsInvestigationTrigger =
  (typeof AIOPS_INVESTIGATION_TRIGGERS)[number];

export type InvestigationBudget = {
  maxAgents: number;
  maxToolCalls: number;
  maxLLMCalls: number;
  maxTokens: number;
  maxDurationMs: number;
  maxConcurrentAgents?: number;
  agentTimeoutMs?: number;
};

/** Wave 3: maxLLMCalls 0 salvo política LOCAL/CLOUD. */
export const DEFAULT_INVESTIGATION_BUDGET: InvestigationBudget = {
  maxAgents: 6,
  maxToolCalls: 20,
  maxLLMCalls: 0,
  maxTokens: 0,
  maxDurationMs: 120_000,
  maxConcurrentAgents: 5,
  agentTimeoutMs: 30_000,
};

export type InvestigationEntityRef = {
  entityKey: string;
  kind?: string;
  name?: string;
};

/**
 * Contexto acotado para AIOps Agents. No incluye series ni logs crudos.
 * Extiende IncidentContext Wave 1.
 */
export type IncidentContext = {
  tenantId: string;
  incidentId: string;
  tenantSlug?: string;
  entityType?: string;
  entityKey?: string;
  siteId?: string;
  anomalies?: string[];
  needsBlastRadius?: boolean;
  causeKey?: string;
  blastEntityKeys?: string[];
  affectedEntityKinds?: string[];
};

export type InvestigationContext = IncidentContext & {
  title?: string;
  severity?: string;
  environment?: string;
  windowStart?: string;
  windowEnd?: string;
  deterministicRca?: {
    rcaMode: 'deterministic_engine' | 'correlation_fallback';
    confidence: number | null;
    hypothesis?: string;
    entityKey?: string;
    candidates: Array<{
      entityKey?: string;
      hypothesis: string;
      confidence: number;
      rank: number;
    }>;
  };
  affectedEntities?: InvestigationEntityRef[];
  affectedServices?: InvestigationEntityRef[];
  blastRadius?: {
    hops: number;
    entityCount: number;
    entityKeys: string[];
  };
  anomalySummaries?: Array<{
    summary: string;
    kind?: string;
    entityKey?: string;
  }>;
  topologySummary?: string;
  timeline?: Array<{ occurredAt: string; summary: string }>;
  historicalMatches?: Array<{ incidentId: string; title: string }>;
};

export type AgentSelectionTraceEntry = {
  agentType: AiopsAgentType;
  decision: 'selected' | 'skipped';
  reason: string;
};

/**
 * Corrida del AgentOrchestrator. Persistida (tabla AiopsInvestigation).
 * incidentLifecycle es el mapeo AIOps; no cambia Incident.status.
 */
export type AiopsInvestigation = {
  id: string;
  tenantId: string;
  incidentId: string;
  status: AiopsInvestigationStatus;
  incidentLifecycle?: IncidentLifecycle;
  trigger: string;
  version: number;
  selectedAgents: AiopsAgentType[];
  skippedAgents: AiopsAgentType[];
  selectionTrace?: AgentSelectionTraceEntry[];
  budget: InvestigationBudget;
  budgetUsed?: Partial<InvestigationBudget>;
  privacyMode?: string;
  synthesisSummary?: string;
  synthesisEvidence?: unknown;
  investigationResult?: InvestigationResult;
  primaryFindingId?: string;
  errorCode?: string;
  errorDetail?: string;
  correlationId?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

export function toProductInvestigationStatus(
  status: AiopsInvestigationStatus,
): ProductInvestigationStatus {
  if (status === 'QUEUED') return 'PENDING';
  if (status === 'SYNTHESIZING') return 'RUNNING';
  if (status === 'BUDGET_EXCEEDED') return 'FAILED';
  if (
    status === 'PENDING' ||
    status === 'RUNNING' ||
    status === 'PARTIAL' ||
    status === 'COMPLETED' ||
    status === 'FAILED' ||
    status === 'TIMEOUT' ||
    status === 'CANCELLED'
  ) {
    return status;
  }
  return 'FAILED';
}

export function isActiveInvestigationStatus(
  status: AiopsInvestigationStatus,
): boolean {
  return ACTIVE_INVESTIGATION_STATUSES.includes(status);
}
