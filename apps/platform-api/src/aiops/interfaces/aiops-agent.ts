import type { AgentFinding } from '../types/agent-finding';
import type { AiopsAgentType } from '../types/aiops-agent-type';
import type {
  IncidentContext,
  InvestigationContext,
} from '../types/aiops-investigation';
import type { ToolCallAudit } from '../types/tool-call';

export type AiopsAgentInput = {
  tenantId: string;
  incidentId: string;
  investigationId?: string;
  context: IncidentContext;
};

export type AiopsAgentPlan = {
  steps: string[];
  tools: string[];
};

export type AiopsAgentExecuteInput = AiopsAgentInput & {
  context: InvestigationContext;
  budget: {
    maxToolCalls: number;
    timeoutMs: number;
  };
  signal?: AbortSignal;
};

export type AiopsAgentExecuteResult = {
  finding: AgentFinding;
  toolCalls: ToolCallAudit[];
};

/**
 * Contrato de un AIOps Agent (investigador). No es el recolector.
 * investigate() permanece como fachada Wave 1 → execute + summarize.
 */
export interface AiopsAgent {
  readonly agentType: AiopsAgentType;
  canHandle(context: InvestigationContext): boolean;
  plan(context: InvestigationContext): Promise<AiopsAgentPlan> | AiopsAgentPlan;
  execute(input: AiopsAgentExecuteInput): Promise<AiopsAgentExecuteResult>;
  summarize(result: AiopsAgentExecuteResult): string;
  investigate(input: AiopsAgentInput): Promise<AgentFinding>;
}
