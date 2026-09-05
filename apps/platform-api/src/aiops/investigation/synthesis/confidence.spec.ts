import { investigationConfidence } from './confidence';
import type { AgentFinding } from '../../types/agent-finding';

describe('investigationConfidence', () => {
  const finding = (
    agentType: string,
    status: AgentFinding['status'],
    confidence: number,
  ): AgentFinding => ({
    id: `${agentType}-1`,
    tenantId: 't',
    incidentId: 'i',
    agentType,
    status,
    summary: `${agentType} ok`,
    evidence: status === 'COMPLETED' ? [{ kind: 'x', summary: 'e' }] : [],
    confidence,
  });

  it('no deja que el LLM suba mas de 0.05 sobre la base', () => {
    const findings = [
      finding('Rca', 'COMPLETED', 0.8),
      finding('Metrics', 'COMPLETED', 0.8),
      finding('Topology', 'COMPLETED', 0.8),
    ];
    const without = investigationConfidence({
      deterministicConfidence: 0.8,
      findings,
      selectedSpecialists: 3,
      usedLlm: false,
    });
    const withLlm = investigationConfidence({
      deterministicConfidence: 0.8,
      findings,
      selectedSpecialists: 3,
      usedLlm: true,
      llmAgreed: true,
    });
    expect(withLlm).toBeLessThanOrEqual(without + 0.05 + 1e-9);
    expect(withLlm).toBeGreaterThanOrEqual(without);
  });

  it('PARTIAL no infla cobertura: FAILED cuenta en el denominador', () => {
    const findings = [
      finding('Rca', 'COMPLETED', 0.9),
      finding('Metrics', 'FAILED', 0),
      finding('Logs', 'TIMEOUT', 0),
    ];
    const score = investigationConfidence({
      deterministicConfidence: 0.9,
      findings,
      selectedSpecialists: 3,
      usedLlm: false,
    });
    expect(score).toBeLessThan(0.9);
  });
});
