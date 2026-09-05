export type InvestigationRecommendedAction = {
  type: string;
  description: string;
  evidence: string[];
  risk: 'low' | 'medium' | 'high';
  requiresApproval: true;
};

export type InvestigationResult = {
  summary: string;
  probableRootCause: string;
  confidence: number;
  supportingEvidence: string[];
  contradictingEvidence: string[];
  affectedServices: string[];
  recommendedActions: InvestigationRecommendedAction[];
  unresolvedQuestions: string[];
  agentAgreement: number;
  provider?: string;
  model?: string;
  redactionApplied?: boolean;
  synthesisMode: 'deterministic' | 'llm';
};

export function emptyInvestigationResult(
  summary = 'Sin síntesis.',
): InvestigationResult {
  return {
    summary,
    probableRootCause: 'Sin causa probable',
    confidence: 0,
    supportingEvidence: [],
    contradictingEvidence: [],
    affectedServices: [],
    recommendedActions: [],
    unresolvedQuestions: [],
    agentAgreement: 0,
    synthesisMode: 'deterministic',
  };
}
