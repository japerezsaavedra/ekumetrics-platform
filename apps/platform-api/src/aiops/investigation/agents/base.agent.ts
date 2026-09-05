import type { AgentFinding } from '../../types/agent-finding';
import type {
  AiopsAgent,
  AiopsAgentExecuteInput,
  AiopsAgentExecuteResult,
  AiopsAgentInput,
  AiopsAgentPlan,
} from '../../interfaces/aiops-agent';
import type { AiopsAgentType } from '../../types/aiops-agent-type';
import type { InvestigationContext } from '../../types/aiops-investigation';

export abstract class BaseAiopsAgent implements AiopsAgent {
  abstract readonly agentType: AiopsAgentType;

  canHandle(_context: InvestigationContext): boolean {
    return true;
  }

  plan(_context: InvestigationContext): AiopsAgentPlan {
    return { steps: [this.agentType], tools: [] };
  }

  abstract execute(
    input: AiopsAgentExecuteInput,
  ): Promise<AiopsAgentExecuteResult>;

  summarize(result: AiopsAgentExecuteResult): string {
    return result.finding.summary;
  }

  async investigate(input: AiopsAgentInput): Promise<AgentFinding> {
    const executed = await this.execute({
      ...input,
      context: input.context,
      budget: { maxToolCalls: 8, timeoutMs: 30_000 },
    });
    return executed.finding;
  }

  protected finding(
    input: AiopsAgentExecuteInput,
    partial: Omit<
      AgentFinding,
      'id' | 'tenantId' | 'incidentId' | 'investigationId' | 'agentType'
    >,
  ): AgentFinding {
    return {
      id: `finding-${this.agentType}-${input.incidentId}`,
      tenantId: input.tenantId,
      incidentId: input.incidentId,
      investigationId: input.investigationId,
      agentType: this.agentType,
      ...partial,
    };
  }
}
