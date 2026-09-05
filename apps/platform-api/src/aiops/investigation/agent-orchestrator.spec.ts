import { ConflictException } from '@nestjs/common';
import { DEFAULT_INVESTIGATION_BUDGET } from '../types/aiops-investigation';
import { AgentOrchestratorService } from './agent-orchestrator';
import type { AiopsAgent } from '../interfaces/aiops-agent';

function finding(agentType: string, status: 'COMPLETED' | 'FAILED' | 'SKIPPED') {
  return {
    finding: {
      id: `f-${agentType}`,
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
      agentType,
      status,
      summary: `${agentType} ${status}`,
      evidence:
        status === 'COMPLETED'
          ? [{ kind: 'x', summary: `${agentType} evidence` }]
          : [{ kind: 'x', summary: 'error' }],
      confidence: status === 'COMPLETED' ? 0.8 : 0,
    },
    toolCalls: [],
  };
}

describe('AgentOrchestratorService', () => {
  function setup(agents: AiopsAgent[]) {
    const created = {
      id: 'inv-1',
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
      status: 'PENDING' as const,
      trigger: 'operator',
      version: 1,
      selectedAgents: agents.map((item) => item.agentType),
      skippedAgents: [],
      selectionTrace: [],
      budget: DEFAULT_INVESTIGATION_BUDGET,
    };
    const investigations = {
      findActiveByIncident: jest.fn().mockResolvedValue(null),
      findLatestByIncident: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(created),
      findById: jest.fn().mockResolvedValue(created),
      update: jest.fn().mockImplementation((_t, _id, patch) =>
        Promise.resolve({ ...created, ...patch }),
      ),
    };
    const stored: unknown[] = [];
    const findings = {
      create: jest.fn().mockImplementation((_t, input) => {
        const row = { id: `id-${stored.length}`, ...input };
        stored.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn().mockImplementation((_t, id, patch) => {
        const index = stored.findIndex((item) => (item as { id: string }).id === id);
        const current = index >= 0 ? stored[index] : { id };
        const next = { ...(current as object), ...patch, id };
        if (index >= 0) stored[index] = next;
        else stored.push(next);
        return Promise.resolve(next);
      }),
      listByInvestigation: jest.fn().mockImplementation(() => Promise.resolve(stored)),
    };
    const policyService = {
      resolve: jest.fn().mockResolvedValue({
        tenantId: 'tenant-a',
        mode: 'MANUAL',
        privacyMode: 'AI_DISABLED',
        enabledAgentTypes: ['Rca', 'Metrics', 'Logs', 'Kubernetes', 'Topology', 'Synthesis'],
        holmesKubernetesEnabled: false,
        budget: {
          ...DEFAULT_INVESTIGATION_BUDGET,
          maxConcurrentAgents: 5,
          agentTimeoutMs: 30_000,
        },
      }),
    };
    const selection = {
      select: jest.fn().mockReturnValue({
        selected: agents.map((item) => item.agentType),
        skipped: [],
        trace: [],
      }),
    };
    const synthesisAgent = {
      bind: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({
        finding: {
          status: 'COMPLETED',
          summary: 'Sintesis determinista',
          evidence: [{ kind: 'synthesis', summary: 'ok' }],
          confidence: 0.8,
          provider: 'deterministic_synthesis',
        },
        toolCalls: [],
      }),
    };
    const kubernetesAgent = { bindPolicy: jest.fn() };
    const prisma = {
      incident: { findFirst: jest.fn().mockResolvedValue({ id: 'inc-1', tenantId: 'tenant-a', title: 't', severity: 'error', siteId: null, causeKey: 'db', windowStart: null, windowEnd: null }) },
      tenant: { findFirst: jest.fn().mockResolvedValue({ id: 'tenant-a', slug: 'acme' }) },
    };
    const orchestrator = new AgentOrchestratorService(
      investigations as never,
      findings as never,
      policyService as never,
      selection as never,
      { recordInvestigation: jest.fn(), recordAgent: jest.fn(), recordToolCall: jest.fn(), recordBudgetExhausted: jest.fn(), render: () => '' } as never,
      agents,
      synthesisAgent as never,
      kubernetesAgent as never,
      { build: jest.fn().mockReturnValue({ tenantId: 'tenant-a', incidentId: 'inc-1' }) } as never,
      prisma as never,
    );
    return { orchestrator, investigations };
  }

  it('rechaza investigaciones duplicadas en curso', async () => {
    const rca: AiopsAgent = {
      agentType: 'Rca',
      canHandle: () => true,
      plan: () => ({ steps: [], tools: [] }),
      execute: jest.fn().mockResolvedValue(finding('Rca', 'COMPLETED')),
      summarize: () => 'rca',
      investigate: jest.fn(),
    };
    const { orchestrator, investigations } = setup([rca]);
    investigations.findActiveByIncident.mockResolvedValue({ id: 'inv-open' });
    await expect(
      orchestrator.run({
        tenantId: 'tenant-a',
        incidentId: 'inc-1',
        context: { tenantId: 'tenant-a', incidentId: 'inc-1' },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('aisla un agente FAILED y termina PARTIAL', async () => {
    const rca: AiopsAgent = {
      agentType: 'Rca',
      canHandle: () => true,
      plan: () => ({ steps: [], tools: [] }),
      execute: jest.fn().mockResolvedValue(finding('Rca', 'COMPLETED')),
      summarize: () => 'rca',
      investigate: jest.fn(),
    };
    const metrics: AiopsAgent = {
      agentType: 'Metrics',
      canHandle: () => true,
      plan: () => ({ steps: [], tools: [] }),
      execute: jest.fn().mockResolvedValue(finding('Metrics', 'FAILED')),
      summarize: () => 'metrics',
      investigate: jest.fn(),
    };
    const { orchestrator } = setup([rca, metrics]);
    const result = await orchestrator.run({
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
      context: { tenantId: 'tenant-a', incidentId: 'inc-1' },
    });
    expect(result.status).toBe('PARTIAL');
  });
});
