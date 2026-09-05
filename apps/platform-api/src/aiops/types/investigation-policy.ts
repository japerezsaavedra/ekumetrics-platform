export const INVESTIGATION_PRIVACY_MODES = [
  'AI_DISABLED',
  'LOCAL_ONLY',
  'CLOUD_REDACTED',
  'CLOUD_ALLOWED',
] as const;

export type InvestigationPrivacyMode =
  (typeof INVESTIGATION_PRIVACY_MODES)[number];

export const INVESTIGATION_POLICY_MODES = ['MANUAL', 'AUTOMATIC'] as const;

export type InvestigationPolicyMode =
  (typeof INVESTIGATION_POLICY_MODES)[number];

export type InvestigationPolicy = {
  tenantId: string;
  mode: InvestigationPolicyMode;
  privacyMode: InvestigationPrivacyMode;
  enabledAgentTypes: string[];
  holmesKubernetesEnabled: boolean;
  budget: {
    maxAgents: number;
    maxToolCalls: number;
    maxLLMCalls: number;
    maxTokens: number;
    maxDurationMs: number;
    maxConcurrentAgents: number;
    agentTimeoutMs: number;
  };
};

export const DEFAULT_ENABLED_AGENT_TYPES = [
  'Rca',
  'Metrics',
  'Logs',
  'Kubernetes',
  'Topology',
  'Synthesis',
] as const;

export function defaultInvestigationPolicy(
  tenantId: string,
): InvestigationPolicy {
  return {
    tenantId,
    mode: 'MANUAL',
    privacyMode: 'AI_DISABLED',
    enabledAgentTypes: [...DEFAULT_ENABLED_AGENT_TYPES],
    holmesKubernetesEnabled: false,
    budget: {
      maxAgents: 6,
      maxToolCalls: 20,
      maxLLMCalls: 0,
      maxTokens: 0,
      maxDurationMs: 120_000,
      maxConcurrentAgents: 5,
      agentTimeoutMs: 30_000,
    },
  };
}

export function effectiveLlmBudget(
  privacyMode: InvestigationPrivacyMode,
  requested: number,
): number {
  if (privacyMode === 'AI_DISABLED') return 0;
  return Math.max(0, requested);
}
