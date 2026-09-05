import { AgentOrchestratorStub } from './agent-orchestrator.stub';
import { RcaAgentStub } from './rca-agent.stub';
import { RcaEngineStub } from './rca-engine.stub';

describe('stubs AIOps wave 1', () => {
  const context = {
    tenantId: 'tenant-a',
    incidentId: 'inc-1',
    entityType: 'K8S_POD',
  };

  it('RcaEngine no produce hipótesis ni llama LLM', async () => {
    const engine = new RcaEngineStub();
    await expect(
      engine.propose({ tenantId: 'tenant-a', incidentId: 'inc-1' }),
    ).resolves.toEqual([]);
  });

  it('RcaAgent devuelve SKIPPED sin tools', async () => {
    const agent = new RcaAgentStub();
    const finding = await agent.investigate({
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
      context,
    });
    expect(finding.status).toBe('SKIPPED');
    expect(finding.agentType).toBe('Rca');
    expect(finding.evidence).toEqual([]);
  });

  it('AgentOrchestrator selecciona pero no despacha el loop', async () => {
    const orchestrator = new AgentOrchestratorStub();
    expect(orchestrator.select(context)).toEqual(['Rca', 'Kubernetes']);
    const investigation = await orchestrator.run({
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
      context,
    });
    expect(investigation.status).toBe('QUEUED');
    expect(investigation.selectedAgents).toEqual(['Rca', 'Kubernetes']);
  });
});
