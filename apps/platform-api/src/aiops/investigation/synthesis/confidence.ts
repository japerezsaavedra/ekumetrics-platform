import type { AgentFinding } from '../../types/agent-finding';

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Confianza de InvestigationResult.
 * El LLM no sustituye RcaEngine ni infla mas de +0.05 sobre la base.
 */
export function investigationConfidence(input: {
  deterministicConfidence: number;
  findings: AgentFinding[];
  selectedSpecialists: number;
  llmAgreed?: boolean | null;
  usedLlm?: boolean;
}): number {
  const completed = input.findings.filter(
    (item) =>
      item.status === 'COMPLETED' &&
      item.agentType !== 'Synthesis' &&
      item.evidence.length > 0,
  );
  const specialists = input.findings.filter(
    (item) =>
      item.agentType !== 'Rca' &&
      item.agentType !== 'Synthesis' &&
      item.status === 'COMPLETED',
  );
  const denominator = Math.max(1, input.selectedSpecialists);
  const evidenceCoverage = clamp01(completed.length / denominator);
  const specialistMean =
    specialists.length === 0
      ? 0
      : specialists.reduce((sum, item) => sum + (item.confidence ?? 0), 0) /
        specialists.length;
  const base = clamp01(
    0.55 * clamp01(input.deterministicConfidence) +
      0.25 * clamp01(specialistMean) +
      0.2 * evidenceCoverage,
  );
  if (!input.usedLlm) return base;
  let delta = 0;
  if (input.llmAgreed === true) delta = 0.05;
  if (input.llmAgreed === false) delta = -0.1;
  return clamp01(Math.min(base + 0.05, base + delta));
}

export function agentAgreement(findings: AgentFinding[]): number {
  const keys = findings
    .filter((item) => item.status === 'COMPLETED')
    .flatMap((item) =>
      item.evidence.map((ev) => ev.entityKey).filter((key): key is string => Boolean(key)),
    );
  if (keys.length < 2) return keys.length === 1 ? 1 : 0;
  const counts = new Map<string, number>();
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = Math.max(...counts.values());
  return clamp01(top / keys.length);
}
