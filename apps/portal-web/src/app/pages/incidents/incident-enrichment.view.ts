export type EnrichmentEvidenceDto = {
  kind: string;
  statement: string;
  score: number;
  confidence: number;
  algorithm: string;
  source: string;
};

export type RootCauseCandidateDto = {
  id: string;
  rank: number;
  entityKey?: string;
  hypothesis: string;
  confidence: number;
  score: number;
  status: string;
  source: string;
  algorithm: string;
  evidence?: EnrichmentEvidenceDto[];
};

export type TimelineEntryDto = {
  occurredAt: string;
  sequence: number;
  summary: string;
  kind: string;
  entityKey?: string;
};

export type HistoricalMatchDto = {
  incidentId: string;
  title: string;
  causeKey?: string | null;
  clusterKey?: string | null;
  status?: string;
  score: number;
  confidence: number;
  algorithm: string;
  source: string;
};

export type IncidentEnrichmentDto = {
  algorithm: string;
  source: string;
  score: number;
  confidence: number;
  rcaConfidence: number | null;
  rcaMode?: 'deterministic_engine' | 'correlation_fallback';
  aiInvestigationStatus?:
    | 'not_executed'
    | 'PENDING'
    | 'RUNNING'
    | 'PARTIAL'
    | 'COMPLETED'
    | 'FAILED'
    | 'TIMEOUT'
    | 'CANCELLED';
  investigationId?: string;
  investigationVersion?: number;
  investigationConfidence?: number | null;
  synthesisSummary?: string;
  computedPriority?: {
    level: string;
    score: number;
    confidence: number;
    algorithm: string;
    source: string;
    factors?: Array<{ id: string; score: number; evidence: string }>;
  };
  anomalies?: Array<{
    id: string;
    summary: string;
    kind: string;
    occurredAt: string;
    algorithm?: string;
    score?: number;
    confidence?: number;
  }>;
  rootCauseCandidates?: RootCauseCandidateDto[];
  primaryRootCause?: RootCauseCandidateDto | null;
  correlationEvidence?: EnrichmentEvidenceDto[];
  blastRadius?: {
    originKey: string | null;
    hops: number;
    entityCount: number;
    entityKeys: string[];
  };
  timeline?: TimelineEntryDto[];
  historicalMatches?: HistoricalMatchDto[];
};

export function enrichmentPriority(value: IncidentEnrichmentDto | null | undefined): string | null {
  return value?.computedPriority?.level ?? null;
}

export function rcaPercent(value: number | null | undefined): string {
  if (value == null) return 'Sin RCA';
  return `${Math.round(value * 100)} %`;
}

export function rcaModeLabel(
  value: IncidentEnrichmentDto | null | undefined,
): string {
  if (value?.rcaMode === 'deterministic_engine') {
    return 'RCA determinista (RcaEngine)';
  }
  return 'RCA determinista (correlación, provisional)';
}

export type InvestigationResultDto = {
  summary: string;
  probableRootCause: string;
  confidence: number;
  supportingEvidence?: string[];
  contradictingEvidence?: string[];
  recommendedActions?: Array<{ type: string; description: string }>;
  unresolvedQuestions?: string[];
  provider?: string;
  model?: string;
  synthesisMode?: string;
};

export type AiopsInvestigationDto = {
  id: string;
  incidentId: string;
  status: string;
  productStatus?: string;
  version: number;
  selectedAgents: string[];
  skippedAgents?: string[];
  startedAt?: string;
  completedAt?: string;
  synthesisSummary?: string;
  investigationResult?: InvestigationResultDto;
};

export type AgentFindingDto = {
  id: string;
  agentType: string;
  status: string;
  summary: string;
  confidence?: number;
  skipReason?: string;
  evidence?: Array<{ kind: string; summary: string }>;
};

export function investigationStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'PENDING':
    case 'QUEUED':
      return 'Pendiente';
    case 'RUNNING':
    case 'SYNTHESIZING':
      return 'En curso';
    case 'PARTIAL':
      return 'Parcial';
    case 'COMPLETED':
      return 'Completada';
    case 'FAILED':
    case 'BUDGET_EXCEEDED':
      return 'Fallida';
    case 'TIMEOUT':
      return 'Timeout';
    case 'CANCELLED':
      return 'Cancelada';
    default:
      return 'No ejecutada';
  }
}

export function agentTypeLabel(agentType: string): string {
  const labels: Record<string, string> = {
    Rca: 'RCA',
    Metrics: 'Métricas',
    Logs: 'Logs',
    Kubernetes: 'Kubernetes',
    Topology: 'Topología',
    Synthesis: 'Síntesis',
  };
  return labels[agentType] ?? agentType;
}
