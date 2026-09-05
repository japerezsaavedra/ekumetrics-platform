import type { AiopsAgentType } from '../types/aiops-agent-type';
import type {
  AiopsInvestigation,
  AiopsInvestigationTrigger,
  IncidentContext,
  InvestigationBudget,
  InvestigationContext,
} from '../types/aiops-investigation';

export const AGENT_ORCHESTRATOR = 'AgentOrchestrator';

export type OrchestratorRunInput = {
  tenantId: string;
  incidentId: string;
  context: IncidentContext | InvestigationContext;
  trigger?: AiopsInvestigationTrigger;
  budget?: InvestigationBudget;
  createdBy?: string;
  retry?: boolean;
  correlationId?: string;
  tenantSlug?: string;
};

/**
 * Despacha AIOps Agents. Dueño de selección y presupuesto.
 * No contiene lógica de RCA, métricas, logs ni Kubernetes.
 */
export interface AgentOrchestrator {
  select(context: IncidentContext | InvestigationContext): AiopsAgentType[];
  run(input: OrchestratorRunInput): Promise<AiopsInvestigation>;
  trigger(input: OrchestratorRunInput): Promise<AiopsInvestigation>;
  cancel(tenantId: string, incidentId: string): Promise<AiopsInvestigation | null>;
}
