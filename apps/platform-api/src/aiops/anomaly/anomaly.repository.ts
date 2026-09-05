import type { AnomalyResult } from './anomaly-result';

export const ANOMALY_REPOSITORY = Symbol('ANOMALY_REPOSITORY');

export interface AnomalyRepository {
  save(tenantId: string, result: AnomalyResult): Promise<AnomalyResult>;
  saveMany(tenantId: string, results: AnomalyResult[]): Promise<AnomalyResult[]>;
  findByTenant(tenantId: string): Promise<AnomalyResult[]>;
  findForEntities(
    tenantId: string,
    entityIds: string[],
    opts?: { windowStart?: Date | null; windowEnd?: Date | null },
  ): Promise<AnomalyResult[]>;
}

export class InMemoryAnomalyRepository implements AnomalyRepository {
  private readonly byTenant = new Map<string, Map<string, AnomalyResult>>();

  async save(tenantId: string, result: AnomalyResult): Promise<AnomalyResult> {
    if (!tenantId) {
      throw new Error('tenantId es obligatorio.');
    }
    if (result.tenantId !== tenantId) {
      throw new Error('El registro no pertenece al tenant.');
    }
    const bucket = this.byTenant.get(tenantId) ?? new Map<string, AnomalyResult>();
    bucket.set(result.id, { ...result, metadata: { ...result.metadata } });
    this.byTenant.set(tenantId, bucket);
    return result;
  }

  async saveMany(
    tenantId: string,
    results: AnomalyResult[],
  ): Promise<AnomalyResult[]> {
    const saved: AnomalyResult[] = [];
    for (const result of results) {
      saved.push(await this.save(tenantId, result));
    }
    return saved;
  }

  async findByTenant(tenantId: string): Promise<AnomalyResult[]> {
    if (!tenantId) return [];
    const bucket = this.byTenant.get(tenantId);
    return bucket ? [...bucket.values()] : [];
  }

  async findForEntities(
    tenantId: string,
    entityIds: string[],
    opts?: { windowStart?: Date | null; windowEnd?: Date | null },
  ): Promise<AnomalyResult[]> {
    if (!tenantId || entityIds.length === 0) return [];
    const wanted = new Set(entityIds);
    const start = opts?.windowStart?.getTime();
    const end = opts?.windowEnd?.getTime();
    return (await this.findByTenant(tenantId)).filter((row) => {
      if (row.tenantId !== tenantId) return false;
      if (!wanted.has(row.entityId)) return false;
      const ts = Date.parse(row.timestamp);
      if (start != null && Number.isFinite(ts) && ts < start) return false;
      if (end != null && Number.isFinite(ts) && ts > end) return false;
      return true;
    });
  }
}
