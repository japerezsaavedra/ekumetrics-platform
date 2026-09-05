import { defaultInvestigationPolicy } from '../types/investigation-policy';
import { InvestigationPolicyService } from './investigation-policy.service';

describe('InvestigationPolicyService', () => {
  it('default de producto es MANUAL y AI_DISABLED', () => {
    const policy = defaultInvestigationPolicy('tenant-a');
    expect(policy.mode).toBe('MANUAL');
    expect(policy.privacyMode).toBe('AI_DISABLED');
    expect(policy.budget.maxLLMCalls).toBe(0);
  });

  it('no investiga en automatico si mode es MANUAL', async () => {
    const store = { findByTenant: jest.fn().mockResolvedValue(null) };
    const service = new InvestigationPolicyService(store as never);
    const policy = await service.resolve('tenant-a');
    expect(service.shouldAutoInvestigate(policy)).toBe(false);
  });

  it('AUTOMATIC es opt-in por tenant', async () => {
    const store = {
      findByTenant: jest.fn().mockResolvedValue({
        tenantId: 'tenant-a',
        mode: 'AUTOMATIC',
        privacyMode: 'AI_DISABLED',
        enabledAgentTypes: ['Rca'],
        holmesKubernetesEnabled: false,
        budget: {},
      }),
    };
    const service = new InvestigationPolicyService(store as never);
    const policy = await service.resolve('tenant-a');
    expect(service.shouldAutoInvestigate(policy)).toBe(true);
  });
});
