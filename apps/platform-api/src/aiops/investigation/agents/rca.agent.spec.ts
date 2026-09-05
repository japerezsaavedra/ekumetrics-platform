import { RcaAgent } from './rca.agent';

describe('RcaAgent', () => {
  const context = {
    tenantId: 't-a',
    incidentId: 'inc-pg',
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

  it('proyecta el snapshot rca.completed y no llama propose', async () => {
    const propose = jest.fn();
    const agent = new RcaAgent({ propose } as never);
    const result = await agent.execute({
      tenantId: 't-a',
      incidentId: 'inc-pg',
      investigationId: 'inv-1',
      context,
      budget: { maxToolCalls: 1, timeoutMs: 1000 },
    });
    expect(propose).not.toHaveBeenCalled();
    expect(result.finding.status).toBe('COMPLETED');
    expect(result.finding.summary).toContain('PostgreSQL');
    expect(result.finding.provider).toBe('deterministic_rca');
    expect(result.finding.evidence.length).toBeGreaterThan(0);
  });

  it('llama propose solo si no hay snapshot', async () => {
    const propose = jest.fn().mockResolvedValue([
      {
        hypothesis: 'API saturada',
        confidence: 0.6,
        entityKey: 'api',
        evidence: [],
      },
    ]);
    const agent = new RcaAgent({ propose } as never);
    const result = await agent.execute({
      tenantId: 't-a',
      incidentId: 'inc-pg',
      context: { tenantId: 't-a', incidentId: 'inc-pg' },
      budget: { maxToolCalls: 1, timeoutMs: 1000 },
    });
    expect(propose).toHaveBeenCalled();
    expect(result.finding.status).toBe('COMPLETED');
    expect(result.finding.evidence.length).toBeGreaterThan(0);
  });
});
