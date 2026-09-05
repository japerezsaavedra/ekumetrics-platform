import { Injectable, Logger } from '@nestjs/common';
import type {
  AiopsAgent,
  AiopsAgentExecuteInput,
  AiopsAgentExecuteResult,
  AiopsAgentInput,
  AiopsAgentPlan,
} from '../interfaces/aiops-agent';
import type { AgentFinding } from '../types/agent-finding';
import type { InvestigationContext } from '../types/aiops-investigation';

/**
 * Stub de RcaAgent conservado para tests Wave 1.
 */
@Injectable()
export class RcaAgentStub implements AiopsAgent {
  readonly agentType = 'Rca' as const;
  private readonly logger = new Logger(RcaAgentStub.name);

  canHandle(_context: InvestigationContext): boolean {
    return true;
  }

  plan(_context: InvestigationContext): AiopsAgentPlan {
    return { steps: [], tools: [] };
  }

  async execute(
    input: AiopsAgentExecuteInput,
  ): Promise<AiopsAgentExecuteResult> {
    const finding = await this.investigate(input);
    return { finding, toolCalls: [] };
  }

  summarize(result: AiopsAgentExecuteResult): string {
    return result.finding.summary;
  }

  investigate(input: AiopsAgentInput): Promise<AgentFinding> {
    this.logger.log(
      `aiops RcaAgent.investigate stub; no ejecuta tenantId=${input.tenantId} incidentId=${input.incidentId}`,
    );
    return Promise.resolve({
      id: `finding-stub-${input.incidentId}`,
      tenantId: input.tenantId,
      incidentId: input.incidentId,
      investigationId: input.investigationId,
      agentType: this.agentType,
      status: 'SKIPPED',
      summary: 'RcaAgent no ejecutado en wave 1.',
      evidence: [],
    });
  }
}
