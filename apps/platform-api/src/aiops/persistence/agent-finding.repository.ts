import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AgentFinding, AgentFindingStatus } from '../types/agent-finding';
import {
  assertFindingTransition,
  type AgentFindingEvidenceItem,
} from '../types/agent-finding';
import { assertTenantScope, TenantScopeError } from './tenant-scope.error';

export type CreateAgentFindingInput = {
  tenantId?: string;
  incidentId: string;
  investigationId?: string;
  agentType: string;
  status?: AgentFindingStatus;
  summary?: string;
  evidence?: AgentFindingEvidenceItem[];
  confidence?: number;
  startedAt?: Date;
  completedAt?: Date;
  provider?: string;
  model?: string;
  toolCalls?: unknown[];
  errors?: unknown[];
  skipReason?: string;
  plan?: unknown;
};

export type UpdateAgentFindingInput = {
  status?: AgentFindingStatus;
  summary?: string;
  evidence?: AgentFindingEvidenceItem[];
  confidence?: number;
  startedAt?: Date;
  completedAt?: Date;
  provider?: string;
  model?: string;
  toolCalls?: unknown[];
  errors?: unknown[];
  skipReason?: string;
  plan?: unknown;
};

@Injectable()
export class AgentFindingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    tenantId: string,
    input: CreateAgentFindingInput,
  ): Promise<AgentFinding> {
    assertTenantScope(tenantId, input.tenantId);
    await this.assertInvestigationScope(
      tenantId,
      input.investigationId,
      input.incidentId,
    );
    const status = input.status ?? 'PENDING';
    const summary = input.summary ?? '';
    const evidence = input.evidence ?? [];
    if (status === 'COMPLETED') {
      assertCompletedFinding(summary, evidence);
    }
    const row = await this.prisma.agentFinding.create({
      data: {
        tenantId,
        incidentId: input.incidentId,
        investigationId: input.investigationId,
        agentType: input.agentType,
        status,
        summary,
        evidence: evidence as Prisma.InputJsonValue,
        confidence: input.confidence,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        provider: input.provider,
        model: input.model,
        toolCalls: input.toolCalls as Prisma.InputJsonValue | undefined,
        errors: input.errors as Prisma.InputJsonValue | undefined,
        skipReason: input.skipReason,
        plan: input.plan as Prisma.InputJsonValue | undefined,
      },
    });
    return toAgentFinding(row);
  }

  async findById(tenantId: string, id: string): Promise<AgentFinding | null> {
    assertTenantScope(tenantId);
    const row = await this.prisma.agentFinding.findFirst({
      where: { id, tenantId },
    });
    return row ? toAgentFinding(row) : null;
  }

  async listByIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<AgentFinding[]> {
    assertTenantScope(tenantId);
    const rows = await this.prisma.agentFinding.findMany({
      where: { tenantId, incidentId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toAgentFinding);
  }

  async listByInvestigation(
    tenantId: string,
    investigationId: string,
  ): Promise<AgentFinding[]> {
    assertTenantScope(tenantId);
    const rows = await this.prisma.agentFinding.findMany({
      where: { tenantId, investigationId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toAgentFinding);
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateAgentFindingInput,
  ): Promise<AgentFinding> {
    const current = await this.findById(tenantId, id);
    if (!current) {
      throw new TenantScopeError('El AgentFinding no existe en este tenant.');
    }
    if (input.status && input.status !== current.status) {
      assertFindingTransition(current.status, input.status);
    }
    const nextStatus = input.status ?? current.status;
    const nextSummary = input.summary ?? current.summary;
    const nextEvidence = input.evidence ?? current.evidence;
    if (nextStatus === 'COMPLETED') {
      assertCompletedFinding(nextSummary, nextEvidence);
    }
    const row = await this.prisma.agentFinding.update({
      where: { id },
      data: {
        status: input.status,
        summary: input.summary,
        evidence: input.evidence as Prisma.InputJsonValue | undefined,
        confidence: input.confidence,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        provider: input.provider,
        model: input.model,
        toolCalls: input.toolCalls as Prisma.InputJsonValue | undefined,
        errors: input.errors as Prisma.InputJsonValue | undefined,
        skipReason: input.skipReason,
        plan: input.plan as Prisma.InputJsonValue | undefined,
      },
    });
    return toAgentFinding(row);
  }

  private async assertInvestigationScope(
    tenantId: string,
    investigationId: string | undefined,
    incidentId: string,
  ): Promise<void> {
    if (!investigationId) return;
    const investigation = await this.prisma.aiopsInvestigation.findFirst({
      where: { id: investigationId, tenantId },
    });
    if (!investigation) {
      throw new TenantScopeError('La investigación no existe en este tenant.');
    }
    if (investigation.incidentId !== incidentId) {
      throw new TenantScopeError(
        'La investigación no pertenece a este incidente.',
      );
    }
  }
}

function assertCompletedFinding(
  summary: string,
  evidence: AgentFindingEvidenceItem[],
): void {
  if (!summary.trim() || evidence.length === 0) {
    throw new Error(
      'AgentFinding COMPLETED requiere summary y evidencia estructurada.',
    );
  }
}

function toAgentFinding(row: {
  id: string;
  tenantId: string;
  incidentId: string;
  investigationId: string | null;
  agentType: string;
  status: AgentFindingStatus;
  summary: string;
  evidence: unknown;
  confidence: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  provider: string | null;
  model: string | null;
  toolCalls: unknown;
  errors: unknown;
  skipReason?: string | null;
  plan?: unknown;
  createdAt: Date;
  updatedAt: Date;
}): AgentFinding {
  return {
    id: row.id,
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    investigationId: row.investigationId ?? undefined,
    agentType: row.agentType,
    status: row.status,
    summary: row.summary,
    evidence: Array.isArray(row.evidence)
      ? (row.evidence as AgentFindingEvidenceItem[])
      : [],
    confidence: row.confidence ?? undefined,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    toolCalls: Array.isArray(row.toolCalls) ? row.toolCalls : undefined,
    errors: Array.isArray(row.errors) ? row.errors : undefined,
    skipReason: row.skipReason ?? undefined,
    plan: row.plan ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
