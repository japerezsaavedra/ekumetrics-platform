import { Injectable, Logger } from '@nestjs/common';
import type {
  AgentOrchestrator,
  OrchestratorRunInput,
} from '../interfaces/agent-orchestrator';
import type { AiopsAgentType } from '../types/aiops-agent-type';
import type {
  AiopsInvestigation,
  IncidentContext,
} from '../types/aiops-investigation';
import { DEFAULT_INVESTIGATION_BUDGET } from '../types/aiops-investigation';
import { selectAiopsAgents } from '../types/select-aiops-agents';

/**
 * Stub wave 1 conservado para tests. El runtime usa AgentOrchestratorService.
 */
@Injectable()
export class AgentOrchestratorStub implements AgentOrchestrator {
  private readonly logger = new Logger(AgentOrchestratorStub.name);

  select(context: IncidentContext): AiopsAgentType[] {
    return selectAiopsAgents(context);
  }

  trigger(input: OrchestratorRunInput): Promise<AiopsInvestigation> {
    return this.run(input);
  }

  cancel(): Promise<AiopsInvestigation | null> {
    return Promise.resolve(null);
  }

  run(input: OrchestratorRunInput): Promise<AiopsInvestigation> {
    const selectedAgents = this.select(input.context);
    this.logger.log(
      `aiops AgentOrchestrator.run stub; no despacha AIOps Agents tenantId=${input.tenantId} incidentId=${input.incidentId} selected=${selectedAgents.join(',')}`,
    );
    return Promise.resolve({
      id: `inv-stub-${input.incidentId}`,
      tenantId: input.tenantId,
      incidentId: input.incidentId,
      status: 'QUEUED',
      trigger: input.trigger ?? 'auto',
      version: 1,
      selectedAgents,
      skippedAgents: [],
      budget: input.budget ?? DEFAULT_INVESTIGATION_BUDGET,
      createdBy: input.createdBy,
    });
  }
}
