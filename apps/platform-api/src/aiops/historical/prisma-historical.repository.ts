import { Injectable } from '@nestjs/common';
import { Prisma, type RcaFeedbackAction as PrismaRcaFeedbackAction } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assertTenantScope, TenantScopeError } from '../persistence/tenant-scope.error';
import type {
  CreateFeedbackInput,
  HistoricalRepository,
  UpsertResolutionInput,
  UpsertSignatureInput,
} from './historical.repository';
import type {
  IncidentSignature,
  RcaFeedback,
  RcaFeedbackAction,
  ResolutionRecord,
} from './types';
import { SIGNATURE_VERSION } from './types';

@Injectable()
export class PrismaHistoricalRepository implements HistoricalRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsertSignature(
    input: UpsertSignatureInput,
  ): Promise<IncidentSignature> {
    assertTenantScope(input.tenantId);
    const existing = await this.prisma.incidentSignature.findUnique({
      where: {
        tenantId_hash: { tenantId: input.tenantId, hash: input.hash },
      },
    });
    const incidentIds = existing ? [...existing.incidentIds] : [];
    if (input.incidentId && !incidentIds.includes(input.incidentId)) {
      incidentIds.push(input.incidentId);
    }
    const row = existing
      ? await this.prisma.incidentSignature.update({
          where: { id: existing.id },
          data: {
            entityTypes: input.entityTypes,
            serviceKey: input.serviceKey,
            eventTypes: input.eventTypes,
            anomalyTypes: input.anomalyTypes,
            topologyPattern: input.topologyPattern,
            environment: input.environment,
            incidentIds,
          },
        })
      : await this.prisma.incidentSignature.create({
          data: {
            tenantId: input.tenantId,
            hash: input.hash,
            version: SIGNATURE_VERSION,
            entityTypes: input.entityTypes,
            serviceKey: input.serviceKey,
            eventTypes: input.eventTypes,
            anomalyTypes: input.anomalyTypes,
            topologyPattern: input.topologyPattern,
            environment: input.environment,
            incidentIds,
          },
        });
    return fromSignature(row);
  }

  async findSignatureByHash(
    tenantId: string,
    hash: string,
  ): Promise<IncidentSignature | null> {
    assertTenantScope(tenantId);
    const row = await this.prisma.incidentSignature.findUnique({
      where: { tenantId_hash: { tenantId, hash } },
    });
    if (!row || row.tenantId !== tenantId) return null;
    return fromSignature(row);
  }

  async findSignatureByIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<IncidentSignature | null> {
    assertTenantScope(tenantId);
    const row = await this.prisma.incidentSignature.findFirst({
      where: { tenantId, incidentIds: { has: incidentId } },
    });
    if (!row || row.tenantId !== tenantId) return null;
    return fromSignature(row);
  }

  async listSignatures(tenantId: string): Promise<IncidentSignature[]> {
    assertTenantScope(tenantId);
    const rows = await this.prisma.incidentSignature.findMany({
      where: { tenantId },
    });
    return rows.filter((row) => row.tenantId === tenantId).map(fromSignature);
  }

  async upsertResolution(
    input: UpsertResolutionInput,
  ): Promise<ResolutionRecord> {
    assertTenantScope(input.tenantId);
    const existing = await this.prisma.resolutionRecord.findFirst({
      where: { tenantId: input.tenantId, incidentId: input.incidentId },
      orderBy: { createdAt: 'desc' },
    });
    const rejected = new Set(asStringArray(existing?.rejectedRootCauses));
    for (const cause of input.rejectedRootCauses ?? []) {
      if (cause) rejected.add(cause);
    }
    for (const cause of input.appendRejected ?? []) {
      if (cause) rejected.add(cause);
    }
    const confirmed =
      input.confirmedRootCause === null
        ? null
        : (input.confirmedRootCause ?? existing?.confirmedRootCause);
    const data = {
      tenantId: input.tenantId,
      incidentId: input.incidentId,
      signatureId: input.signatureId ?? existing?.signatureId,
      confirmedRootCause: confirmed,
      rejectedRootCauses: [...rejected] as Prisma.InputJsonValue,
      resolution: input.resolution ?? existing?.resolution,
      successfulAction: input.successfulAction ?? existing?.successfulAction,
      timeToDetectMs: input.timeToDetectMs ?? existing?.timeToDetectMs,
      timeToResolveMs: input.timeToResolveMs ?? existing?.timeToResolveMs,
    };
    const row = existing
      ? await this.prisma.resolutionRecord.update({
          where: { id: existing.id },
          data,
        })
      : await this.prisma.resolutionRecord.create({ data });
    return fromResolution(row);
  }

  async findResolutionByIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<ResolutionRecord | null> {
    assertTenantScope(tenantId);
    const row = await this.prisma.resolutionRecord.findFirst({
      where: { tenantId, incidentId },
      orderBy: { createdAt: 'desc' },
    });
    if (!row || row.tenantId !== tenantId) return null;
    return fromResolution(row);
  }

  async listResolutions(tenantId: string): Promise<ResolutionRecord[]> {
    assertTenantScope(tenantId);
    const rows = await this.prisma.resolutionRecord.findMany({
      where: { tenantId },
    });
    return rows.filter((row) => row.tenantId === tenantId).map(fromResolution);
  }

  async createFeedback(input: CreateFeedbackInput): Promise<RcaFeedback> {
    assertTenantScope(input.tenantId);
    const incident = await this.prisma.incident.findFirst({
      where: { id: input.incidentId, tenantId: input.tenantId },
      select: { id: true },
    });
    if (!incident) {
      throw new TenantScopeError();
    }
    const row = await this.prisma.rcaFeedback.create({
      data: {
        tenantId: input.tenantId,
        incidentId: input.incidentId,
        action: input.action as PrismaRcaFeedbackAction,
        selectedEntityId: input.selectedEntityId,
        note: input.note,
        userId: input.userId,
      },
    });
    return fromFeedback(row);
  }

  async listFeedback(
    tenantId: string,
    incidentId: string,
  ): Promise<RcaFeedback[]> {
    assertTenantScope(tenantId);
    const rows = await this.prisma.rcaFeedback.findMany({
      where: { tenantId, incidentId },
      orderBy: { createdAt: 'asc' },
    });
    return rows
      .filter((row) => row.tenantId === tenantId)
      .map(fromFeedback);
  }
}

function fromSignature(row: {
  id: string;
  tenantId: string;
  hash: string;
  version: string;
  entityTypes: string[];
  serviceKey: string | null;
  eventTypes: string[];
  anomalyTypes: string[];
  topologyPattern: string | null;
  environment: string | null;
  incidentIds: string[];
  createdAt: Date;
  updatedAt: Date;
}): IncidentSignature {
  return {
    id: row.id,
    tenantId: row.tenantId,
    hash: row.hash,
    version: SIGNATURE_VERSION,
    entityTypes: [...row.entityTypes],
    serviceKey: row.serviceKey ?? '',
    eventTypes: [...row.eventTypes],
    anomalyTypes: [...row.anomalyTypes],
    topologyPattern: row.topologyPattern ?? '',
    environment: row.environment ?? '',
    incidentIds: [...row.incidentIds],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function fromResolution(row: {
  id: string;
  tenantId: string;
  incidentId: string;
  signatureId: string | null;
  confirmedRootCause: string | null;
  rejectedRootCauses: unknown;
  resolution: string | null;
  successfulAction: string | null;
  timeToDetectMs: number | null;
  timeToResolveMs: number | null;
  createdAt: Date;
  updatedAt: Date;
}): ResolutionRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    signatureId: row.signatureId ?? undefined,
    confirmedRootCause: row.confirmedRootCause ?? undefined,
    rejectedRootCauses: asStringArray(row.rejectedRootCauses),
    resolution: row.resolution ?? undefined,
    successfulAction: row.successfulAction ?? undefined,
    timeToDetectMs: row.timeToDetectMs ?? undefined,
    timeToResolveMs: row.timeToResolveMs ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function fromFeedback(row: {
  id: string;
  tenantId: string;
  incidentId: string;
  action: PrismaRcaFeedbackAction;
  selectedEntityId: string | null;
  note: string | null;
  userId: string | null;
  createdAt: Date;
}): RcaFeedback {
  return {
    id: row.id,
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    action: row.action as RcaFeedbackAction,
    selectedEntityId: row.selectedEntityId ?? undefined,
    note: row.note ?? undefined,
    userId: row.userId ?? undefined,
    createdAt: row.createdAt,
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
