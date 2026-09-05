import { selectAiopsAgentsWithTrace } from '../types/select-aiops-agents';
import { synthesizeDeterministic } from './synthesis/deterministic-synthesis';
import type { AgentFinding } from '../types/agent-finding';

describe('E2E sintético PostgreSQL (AI disabled)', () => {
  it('Rca + Metrics + Topology + Logs sintetizan saturacion de PostgreSQL', () => {
    const context = {
      tenantId: 'tenant-a',
      incidentId: 'inc-pg',
      tenantSlug: 'acme',
      entityKey: 'postgres-prod',
      entityType: 'DATABASE',
      causeKey: 'postgres-prod',
      anomalies: ['db latency', 'api latency', 'log errors'],
      needsBlastRadius: true,
      blastRadius: {
        hops: 2,
        entityCount: 9,
        entityKeys: ['api-pagos', 'postgres-prod'],
      },
      affectedServices: [{ entityKey: 'api-pagos', kind: 'SERVICE' }],
      deterministicRca: {
        rcaMode: 'deterministic_engine' as const,
        confidence: 0.91,
        hypothesis: 'Saturacion del pool PostgreSQL',
        entityKey: 'postgres-prod',
        candidates: [
          {
            entityKey: 'postgres-prod',
            hypothesis: 'Saturacion del pool PostgreSQL',
            confidence: 0.91,
            rank: 1,
          },
        ],
      },
    };
    const selection = selectAiopsAgentsWithTrace(context);
    expect(selection.selected).toEqual(
      expect.arrayContaining(['Rca', 'Metrics', 'Logs', 'Topology']),
    );
    expect(selection.selected).not.toContain('Kubernetes');
    expect(selection.skipped.some((item) => item.agentType === 'Kubernetes')).toBe(
      true,
    );

    const findings: AgentFinding[] = [
      {
        id: 'f-rca',
        tenantId: 'tenant-a',
        incidentId: 'inc-pg',
        agentType: 'Rca',
        status: 'COMPLETED',
        summary: 'Saturacion del pool PostgreSQL',
        confidence: 0.91,
        evidence: [
          { kind: 'rca', summary: 'candidato postgres-prod', entityKey: 'postgres-prod' },
        ],
      },
      {
        id: 'f-metrics',
        tenantId: 'tenant-a',
        incidentId: 'inc-pg',
        agentType: 'Metrics',
        status: 'COMPLETED',
        summary: 'DB latency +420% precede API +370%',
        confidence: 0.92,
        evidence: [
          { kind: 'metric', summary: 'DB latency +420%', entityKey: 'postgres-prod' },
        ],
      },
      {
        id: 'f-logs',
        tenantId: 'tenant-a',
        incidentId: 'inc-pg',
        agentType: 'Logs',
        status: 'COMPLETED',
        summary: 'Errores de connection pool',
        confidence: 0.88,
        evidence: [
          { kind: 'log', summary: 'remaining connection slots', entityKey: 'postgres-prod' },
        ],
      },
      {
        id: 'f-topo',
        tenantId: 'tenant-a',
        incidentId: 'inc-pg',
        agentType: 'Topology',
        status: 'COMPLETED',
        summary: 'API depende de PostgreSQL',
        confidence: 0.8,
        evidence: [
          { kind: 'topology', summary: 'api-pagos -> postgres-prod', entityKey: 'postgres-prod' },
        ],
      },
    ];
    const result = synthesizeDeterministic({
      context,
      findings,
      selectedSpecialists: 4,
    });
    expect(result.probableRootCause).toContain('PostgreSQL');
    expect(result.synthesisMode).toBe('deterministic');
    expect(result.supportingEvidence.join(' ')).toMatch(/latency|pool|postgres/i);
    expect(result.recommendedActions[0]?.requiresApproval).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.7);
  });
});
