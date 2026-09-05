import type { AnomalyPolicy, PolicyMatchInput, ResolvedAnomalyPolicy } from './anomaly-policy';
import { resolveAnomalyPolicy } from './anomaly-policy';

export const ANOMALY_POLICY_REPOSITORY = Symbol('ANOMALY_POLICY_REPOSITORY');

export interface AnomalyPolicyRepository {
  listByTenant(tenantId: string): Promise<AnomalyPolicy[]>;
  upsert(policy: AnomalyPolicy): Promise<AnomalyPolicy>;
  resolve(
    tenantId: string,
    input: Omit<PolicyMatchInput, 'tenantId'>,
  ): Promise<ResolvedAnomalyPolicy>;
}

export class InMemoryAnomalyPolicyRepository implements AnomalyPolicyRepository {
  private readonly policies: AnomalyPolicy[] = [];

  async listByTenant(tenantId: string): Promise<AnomalyPolicy[]> {
    if (!tenantId) return [];
    return this.policies.filter((policy) => policy.tenantId === tenantId);
  }

  async upsert(policy: AnomalyPolicy): Promise<AnomalyPolicy> {
    if (!policy.tenantId) {
      throw new Error('tenantId es obligatorio.');
    }
    const index = this.policies.findIndex((item) => item.id === policy.id);
    if (index >= 0) {
      if (this.policies[index].tenantId !== policy.tenantId) {
        throw new Error('El registro no pertenece al tenant.');
      }
      this.policies[index] = { ...policy };
      return this.policies[index];
    }
    this.policies.push({ ...policy });
    return policy;
  }

  async resolve(
    tenantId: string,
    input: Omit<PolicyMatchInput, 'tenantId'>,
  ): Promise<ResolvedAnomalyPolicy> {
    const scoped = await this.listByTenant(tenantId);
    return resolveAnomalyPolicy(tenantId, scoped, input);
  }
}
