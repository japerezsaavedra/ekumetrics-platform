import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { assertTenantScope } from '../persistence/tenant-scope.error';
import type {
  CreateFeedbackInput,
  HistoricalRepository,
  UpsertResolutionInput,
  UpsertSignatureInput,
} from './historical.repository';
import type {
  IncidentSignature,
  RcaFeedback,
  ResolutionRecord,
} from './types';
import { SIGNATURE_VERSION } from './types';

/**
 * Store por tenant (Map anidado). Aislamiento estructural: no hay índice global.
 */
@Injectable()
export class InMemoryHistoricalRepository implements HistoricalRepository {
  private readonly signatures = new Map<
    string,
    Map<string, IncidentSignature>
  >();
  private readonly incidentToHash = new Map<string, string>();
  private readonly resolutions = new Map<string, Map<string, ResolutionRecord>>();
  private readonly feedback = new Map<string, RcaFeedback[]>();

  async upsertSignature(
    input: UpsertSignatureInput,
  ): Promise<IncidentSignature> {
    assertTenantScope(input.tenantId);
    const now = new Date();
    const bucket = this.signatureBucket(input.tenantId);
    const existing = bucket.get(input.hash);
    const incidentIds = existing ? [...existing.incidentIds] : [];
    if (input.incidentId && !incidentIds.includes(input.incidentId)) {
      incidentIds.push(input.incidentId);
    }
    const row: IncidentSignature = {
      id: existing?.id ?? `isig-${randomUUID()}`,
      tenantId: input.tenantId,
      hash: input.hash,
      version: SIGNATURE_VERSION,
      entityTypes: [...input.entityTypes],
      serviceKey: input.serviceKey,
      eventTypes: [...input.eventTypes],
      anomalyTypes: [...input.anomalyTypes],
      topologyPattern: input.topologyPattern,
      environment: input.environment,
      incidentIds,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    bucket.set(input.hash, row);
    if (input.incidentId) {
      this.incidentToHash.set(
        this.incidentKey(input.tenantId, input.incidentId),
        input.hash,
      );
    }
    return cloneSignature(row);
  }

  async findSignatureByHash(
    tenantId: string,
    hash: string,
  ): Promise<IncidentSignature | null> {
    assertTenantScope(tenantId);
    const row = this.signatureBucket(tenantId).get(hash);
    return row ? cloneSignature(row) : null;
  }

  async findSignatureByIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<IncidentSignature | null> {
    assertTenantScope(tenantId);
    const hash = this.incidentToHash.get(this.incidentKey(tenantId, incidentId));
    if (!hash) return null;
    return this.findSignatureByHash(tenantId, hash);
  }

  async listSignatures(tenantId: string): Promise<IncidentSignature[]> {
    assertTenantScope(tenantId);
    return [...this.signatureBucket(tenantId).values()].map(cloneSignature);
  }

  async upsertResolution(
    input: UpsertResolutionInput,
  ): Promise<ResolutionRecord> {
    assertTenantScope(input.tenantId);
    const now = new Date();
    const bucket = this.resolutionBucket(input.tenantId);
    const existing = bucket.get(input.incidentId);
    const rejected = new Set(existing?.rejectedRootCauses ?? []);
    for (const cause of input.rejectedRootCauses ?? []) {
      if (cause) rejected.add(cause);
    }
    for (const cause of input.appendRejected ?? []) {
      if (cause) rejected.add(cause);
    }
    const confirmed =
      input.confirmedRootCause === null
        ? undefined
        : (input.confirmedRootCause ?? existing?.confirmedRootCause);
    const row: ResolutionRecord = {
      id: existing?.id ?? `rres-${randomUUID()}`,
      tenantId: input.tenantId,
      incidentId: input.incidentId,
      signatureId: input.signatureId ?? existing?.signatureId,
      confirmedRootCause: confirmed,
      rejectedRootCauses: [...rejected],
      resolution: input.resolution ?? existing?.resolution,
      successfulAction: input.successfulAction ?? existing?.successfulAction,
      timeToDetectMs: input.timeToDetectMs ?? existing?.timeToDetectMs,
      timeToResolveMs: input.timeToResolveMs ?? existing?.timeToResolveMs,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    bucket.set(input.incidentId, row);
    return cloneResolution(row);
  }

  async findResolutionByIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<ResolutionRecord | null> {
    assertTenantScope(tenantId);
    const row = this.resolutionBucket(tenantId).get(incidentId);
    return row ? cloneResolution(row) : null;
  }

  async listResolutions(tenantId: string): Promise<ResolutionRecord[]> {
    assertTenantScope(tenantId);
    return [...this.resolutionBucket(tenantId).values()].map(cloneResolution);
  }

  async createFeedback(input: CreateFeedbackInput): Promise<RcaFeedback> {
    assertTenantScope(input.tenantId);
    const row: RcaFeedback = {
      id: `rfb-${randomUUID()}`,
      tenantId: input.tenantId,
      incidentId: input.incidentId,
      action: input.action,
      selectedEntityId: input.selectedEntityId,
      note: input.note,
      userId: input.userId,
      createdAt: new Date(),
    };
    const key = this.incidentKey(input.tenantId, input.incidentId);
    const list = this.feedback.get(key) ?? [];
    list.push(row);
    this.feedback.set(key, list);
    return { ...row };
  }

  async listFeedback(
    tenantId: string,
    incidentId: string,
  ): Promise<RcaFeedback[]> {
    assertTenantScope(tenantId);
    const list =
      this.feedback.get(this.incidentKey(tenantId, incidentId)) ?? [];
    return list.map((row) => ({ ...row }));
  }

  private signatureBucket(tenantId: string): Map<string, IncidentSignature> {
    let bucket = this.signatures.get(tenantId);
    if (!bucket) {
      bucket = new Map();
      this.signatures.set(tenantId, bucket);
    }
    return bucket;
  }

  private resolutionBucket(tenantId: string): Map<string, ResolutionRecord> {
    let bucket = this.resolutions.get(tenantId);
    if (!bucket) {
      bucket = new Map();
      this.resolutions.set(tenantId, bucket);
    }
    return bucket;
  }

  private incidentKey(tenantId: string, incidentId: string): string {
    return `${tenantId}\0${incidentId}`;
  }
}

function cloneSignature(row: IncidentSignature): IncidentSignature {
  return {
    ...row,
    entityTypes: [...row.entityTypes],
    eventTypes: [...row.eventTypes],
    anomalyTypes: [...row.anomalyTypes],
    incidentIds: [...row.incidentIds],
  };
}

function cloneResolution(row: ResolutionRecord): ResolutionRecord {
  return {
    ...row,
    rejectedRootCauses: [...row.rejectedRootCauses],
  };
}
