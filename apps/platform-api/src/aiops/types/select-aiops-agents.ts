import type { AiopsAgentType } from './aiops-agent-type';
import type {
  IncidentContext,
  InvestigationContext,
} from './aiops-investigation';

const K8S_ENTITY_TYPES = new Set([
  'K8S_POD',
  'DEPLOYMENT',
  'NODE',
  'STATEFULSET',
  'DAEMONSET',
]);

export type AgentSelectionDecision = {
  selected: AiopsAgentType[];
  skipped: Array<{ agentType: AiopsAgentType; reason: string }>;
};

function kindsFrom(context: InvestigationContext): string[] {
  const kinds = [
    context.entityType,
    ...(context.affectedEntityKinds ?? []),
    ...(context.affectedEntities ?? []).map((item) => item.kind),
    ...(context.affectedServices ?? []).map((item) => item.kind),
  ]
    .filter((item): item is string => Boolean(item))
    .map((item) => item.toUpperCase());
  return kinds;
}

function hasK8s(context: InvestigationContext): boolean {
  return kindsFrom(context).some((kind) => K8S_ENTITY_TYPES.has(kind));
}

function hasMetricSignal(context: InvestigationContext): boolean {
  const anomalies = [
    ...(context.anomalies ?? []),
    ...(context.anomalySummaries ?? []).map(
      (item) => `${item.kind ?? ''} ${item.summary}`,
    ),
  ];
  return anomalies.some((item) =>
    /metric|cpu|mem|saturat|latency|throughput/i.test(item),
  );
}

function hasLogSignal(context: InvestigationContext): boolean {
  const anomalies = [
    ...(context.anomalies ?? []),
    ...(context.anomalySummaries ?? []).map(
      (item) => `${item.kind ?? ''} ${item.summary}`,
    ),
  ];
  const severity = context.severity ?? '';
  return (
    /error|critical/i.test(severity) ||
    anomalies.some((item) => /log|error|trace|exception/i.test(item))
  );
}

function hasTopologyScope(context: InvestigationContext): boolean {
  return Boolean(
    context.needsBlastRadius ||
      context.causeKey ||
      (context.blastEntityKeys && context.blastEntityKeys.length > 0) ||
      (context.blastRadius && context.blastRadius.entityKeys.length > 0) ||
      (context.anomalies ?? []).some((item) => /blast|neighbor|topology/i.test(item)),
  );
}

/**
 * Política de selección. No ejecuta agentes ni llama LLM.
 * Rca siempre; el resto según entityType / anomalías / blast / causeKey.
 * Synthesis se elige al cierre (no aquí).
 */
export function selectAiopsAgents(context: IncidentContext): AiopsAgentType[] {
  return selectAiopsAgentsWithTrace(context).selected;
}

export function selectAiopsAgentsWithTrace(
  context: InvestigationContext,
): AgentSelectionDecision {
  const selected: AiopsAgentType[] = ['Rca'];
  const skipped: Array<{ agentType: AiopsAgentType; reason: string }> = [];

  if (hasK8s(context)) {
    selected.push('Kubernetes');
  } else {
    skipped.push({ agentType: 'Kubernetes', reason: 'no_k8s_entity' });
  }

  if (hasMetricSignal(context)) {
    selected.push('Metrics');
  } else {
    skipped.push({ agentType: 'Metrics', reason: 'no_metric_signal' });
  }

  if (hasLogSignal(context)) {
    selected.push('Logs');
  } else {
    skipped.push({ agentType: 'Logs', reason: 'no_log_signal' });
  }

  if (hasTopologyScope(context)) {
    selected.push('Topology');
  } else {
    skipped.push({ agentType: 'Topology', reason: 'no_topology_scope' });
  }

  return { selected, skipped };
}
