import type { AgentFinding } from '../../types/agent-finding';
import type { InvestigationContext } from '../../types/aiops-investigation';
import type { InvestigationResult } from '../../types/investigation-result';
import {
  agentAgreement,
  investigationConfidence,
} from './confidence';

export function synthesizeDeterministic(input: {
  context: InvestigationContext;
  findings: AgentFinding[];
  selectedSpecialists: number;
}): InvestigationResult {
  const completed = input.findings.filter((item) => item.status === 'COMPLETED');
  const rca = completed.find((item) => item.agentType === 'Rca');
  const deterministic =
    rca?.confidence ??
    input.context.deterministicRca?.confidence ??
    0;
  const probable =
    rca?.summary ||
    input.context.deterministicRca?.hypothesis ||
    completed[0]?.summary ||
    'Sin causa probable';
  const supporting = completed.flatMap((item) =>
    item.evidence.map((ev) => ev.summary),
  );
  const contradicting = completed.flatMap((item) =>
    (item.errors ?? [])
      .map((err) => (typeof err === 'string' ? err : JSON.stringify(err)))
      .filter(Boolean),
  );
  const failed = input.findings.filter(
    (item) => item.status === 'FAILED' || item.status === 'TIMEOUT',
  );
  const unresolved = failed.map(
    (item) => `${item.agentType} no aporto evidencia (${item.status})`,
  );
  const agreement = agentAgreement(completed);
  const confidence = investigationConfidence({
    deterministicConfidence: deterministic,
    findings: input.findings,
    selectedSpecialists: input.selectedSpecialists,
    usedLlm: false,
  });
  const entity =
    rca?.evidence.find((item) => item.entityKey)?.entityKey ||
    input.context.deterministicRca?.entityKey ||
    input.context.entityKey;
  const actions =
    entity && /postgres|database|sql/i.test(`${probable} ${entity}`)
      ? [
          {
            type: 'review_connection_pool',
            description: `Revisar el pool de conexiones y consultas largas en ${entity}.`,
            evidence: supporting.slice(0, 4),
            risk: 'medium' as const,
            requiresApproval: true as const,
          },
        ]
      : probable !== 'Sin causa probable'
        ? [
            {
              type: 'inspect_entity',
              description: `Inspeccionar ${entity ?? 'la entidad candidata'} y validar el hallazgo con el operador.`,
              evidence: supporting.slice(0, 4),
              risk: 'low' as const,
              requiresApproval: true as const,
            },
          ]
        : [];
  return {
    summary: probable,
    probableRootCause: probable,
    confidence,
    supportingEvidence: supporting.slice(0, 12),
    contradictingEvidence: contradicting.slice(0, 6),
    affectedServices: (input.context.affectedServices ?? []).map(
      (item) => item.entityKey,
    ),
    recommendedActions: actions,
    unresolvedQuestions: unresolved,
    agentAgreement: agreement,
    synthesisMode: 'deterministic',
  };
}
