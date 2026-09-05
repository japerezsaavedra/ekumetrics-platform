import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DEFAULT_INVESTIGATION_BUDGET,
} from '../types/aiops-investigation';
import {
  defaultInvestigationPolicy,
  type InvestigationPolicy,
  type InvestigationPolicyMode,
  type InvestigationPrivacyMode,
} from '../types/investigation-policy';
import { assertTenantScope, TenantScopeError } from '../persistence/tenant-scope.error';

@Injectable()
export class PrismaInvestigationPolicyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByTenant(tenantId: string): Promise<InvestigationPolicy | null> {
    assertTenantScope(tenantId);
    const row = await this.prisma.aiopsInvestigationPolicy.findFirst({
      where: { tenantId },
    });
    return row ? toPolicy(row) : null;
  }
}

@Injectable()
export class InvestigationPolicyService {
  constructor(
    private readonly store: PrismaInvestigationPolicyRepository,
  ) {}

  async resolve(tenantId: string): Promise<InvestigationPolicy> {
    assertTenantScope(tenantId);
    try {
      const row = await this.store.findByTenant(tenantId);
      return row ?? defaultInvestigationPolicy(tenantId);
    } catch (error) {
      if (error instanceof TenantScopeError) throw error;
      return defaultInvestigationPolicy(tenantId);
    }
  }

  shouldAutoInvestigate(policy: InvestigationPolicy): boolean {
    return policy.mode === 'AUTOMATIC';
  }
}

function toPolicy(row: {
  tenantId: string;
  mode: string;
  privacyMode: string;
  enabledAgentTypes: unknown;
  budget: unknown;
  holmesKubernetesEnabled: boolean;
}): InvestigationPolicy {
  const fallback = defaultInvestigationPolicy(row.tenantId);
  const budget =
    row.budget && typeof row.budget === 'object'
      ? { ...fallback.budget, ...(row.budget as object) }
      : fallback.budget;
  return {
    tenantId: row.tenantId,
    mode: (row.mode as InvestigationPolicyMode) || 'MANUAL',
    privacyMode: (row.privacyMode as InvestigationPrivacyMode) || 'AI_DISABLED',
    enabledAgentTypes: Array.isArray(row.enabledAgentTypes)
      ? (row.enabledAgentTypes as string[])
      : fallback.enabledAgentTypes,
    holmesKubernetesEnabled: row.holmesKubernetesEnabled,
    budget: {
      maxAgents: num(budget, 'maxAgents', DEFAULT_INVESTIGATION_BUDGET.maxAgents),
      maxToolCalls: num(
        budget,
        'maxToolCalls',
        DEFAULT_INVESTIGATION_BUDGET.maxToolCalls,
      ),
      maxLLMCalls: num(
        budget,
        'maxLLMCalls',
        DEFAULT_INVESTIGATION_BUDGET.maxLLMCalls,
      ),
      maxTokens: num(budget, 'maxTokens', DEFAULT_INVESTIGATION_BUDGET.maxTokens),
      maxDurationMs: num(
        budget,
        'maxDurationMs',
        DEFAULT_INVESTIGATION_BUDGET.maxDurationMs,
      ),
      maxConcurrentAgents: num(budget, 'maxConcurrentAgents', 5),
      agentTimeoutMs: num(budget, 'agentTimeoutMs', 30_000),
    },
  };
}

function num(
  budget: object,
  key: string,
  fallback: number,
): number {
  const value = (budget as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
