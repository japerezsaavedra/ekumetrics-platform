import { Injectable } from '@nestjs/common';
import type { AiopsAgentType } from '../types/aiops-agent-type';
import type {
  AgentSelectionTraceEntry,
  InvestigationBudget,
  InvestigationContext,
} from '../types/aiops-investigation';
import type { InvestigationPolicy } from '../types/investigation-policy';
import { selectAiopsAgentsWithTrace } from '../types/select-aiops-agents';

const PRIORITY: AiopsAgentType[] = [
  'Rca',
  'Topology',
  'Metrics',
  'Logs',
  'Kubernetes',
];

@Injectable()
export class AgentSelectionService {
  select(
    context: InvestigationContext,
    policy: InvestigationPolicy,
    budget: InvestigationBudget,
  ): {
    selected: AiopsAgentType[];
    skipped: AiopsAgentType[];
    trace: AgentSelectionTraceEntry[];
  } {
    const enabled = new Set(policy.enabledAgentTypes);
    const decision = selectAiopsAgentsWithTrace(context);
    const allowed = decision.selected.filter((type) => enabled.has(type));
    const cap = Math.max(1, budget.maxAgents);
    const ranked = PRIORITY.filter((type) => allowed.includes(type)).slice(
      0,
      cap,
    );
    const skippedFromPolicy = decision.selected
      .filter((type) => !enabled.has(type))
      .map((agentType) => ({
        agentType,
        decision: 'skipped' as const,
        reason: 'disabled_by_policy',
      }));
    const skippedByCap = allowed
      .filter((type) => !ranked.includes(type))
      .map((agentType) => ({
        agentType,
        decision: 'skipped' as const,
        reason: 'max_agents',
      }));
    const skippedTrace: AgentSelectionTraceEntry[] = [
      ...decision.skipped.map((item) => ({
        agentType: item.agentType,
        decision: 'skipped' as const,
        reason: item.reason,
      })),
      ...skippedFromPolicy,
      ...skippedByCap,
    ];
    const selectedTrace: AgentSelectionTraceEntry[] = ranked.map(
      (agentType) => ({
        agentType,
        decision: 'selected' as const,
        reason: agentType === 'Rca' ? 'always' : 'policy_match',
      }),
    );
    return {
      selected: ranked,
      skipped: skippedTrace.map((item) => item.agentType),
      trace: [...selectedTrace, ...skippedTrace],
    };
  }
}
