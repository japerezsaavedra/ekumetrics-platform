import type { FutureAiopsAgentType } from '../types/aiops-agent-type';
import type { AiopsAgent } from '../interfaces/aiops-agent';

/**
 * Interfaces compilables para AIOps Agents futuros. Wave 3 no los ejecuta.
 */
export const FUTURE_AGENT_CONTRACTS: readonly FutureAiopsAgentType[] = [
  'Network',
  'Database',
  'Application',
  'Change',
  'Security',
  'Capacity',
  'Remediation',
];

export type FutureAiopsAgent = Pick<AiopsAgent, 'agentType' | 'canHandle'>;
