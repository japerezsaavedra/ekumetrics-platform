import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AiopsAgentType } from '../types/aiops-agent-type';
import type {
  AgentSelectionTraceEntry,
  AiopsInvestigation,
  AiopsInvestigationStatus,
  AiopsInvestigationTrigger,
  InvestigationBudget,
} from '../types/aiops-investigation';
import {
  DEFAULT_INVESTIGATION_BUDGET,
  isActiveInvestigationStatus,
} from '../types/aiops-investigation';
import type { IncidentLifecycle } from '../types/incident-lifecycle';
import type { InvestigationResult } from '../types/investigation-result';
import { assertTenantScope, TenantScopeError } from './tenant-scope.error';

export type CreateInvestigationInput = {
  tenantId?: string;
  incidentId: string;
  status?: AiopsInvestigationStatus;
  incidentLifecycle?: IncidentLifecycle;
  trigger?: AiopsInvestigationTrigger;
  version?: number;
  selectedAgents?: AiopsAgentType[];
  skippedAgents?: AiopsAgentType[];
  selectionTrace?: AgentSelectionTraceEntry[];
  budget?: InvestigationBudget;
  privacyMode?: string;
  correlationId?: string;
  createdBy?: string;
  startedAt?: Date;
};

export type UpdateInvestigationInput = {
  status?: AiopsInvestigationStatus;
  incidentLifecycle?: IncidentLifecycle;
  selectedAgents?: AiopsAgentType[];
  skippedAgents?: AiopsAgentType[];
  selectionTrace?: AgentSelectionTraceEntry[];
  budgetUsed?: Partial<InvestigationBudget>;
  synthesisSummary?: string;
  synthesisEvidence?: unknown;
  investigationResult?: InvestigationResult;
  primaryFindingId?: string;
  errorCode?: string | null;
  errorDetail?: string | null;
  startedAt?: Date;
  completedAt?: Date;
};

@Injectable()
export class InvestigationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    tenantId: string,
    input: CreateInvestigationInput,
  ): Promise<AiopsInvestigation> {
    assertTenantScope(tenantId, input.tenantId);
    const row = await this.prisma.aiopsInvestigation.create({
      data: {
        tenantId,
        incidentId: input.incidentId,
        status: input.status ?? 'PENDING',
        incidentLifecycle: input.incidentLifecycle,
        trigger: input.trigger ?? 'auto',
        version: input.version ?? 1,
        selectedAgents: input.selectedAgents ?? [],
        skippedAgents: input.skippedAgents ?? [],
        selectionTrace: input.selectionTrace as
          | Prisma.InputJsonValue
          | undefined,
        budget: input.budget ?? DEFAULT_INVESTIGATION_BUDGET,
        privacyMode: input.privacyMode,
        correlationId: input.correlationId,
        createdBy: input.createdBy,
        startedAt: input.startedAt,
      },
    });
    return toInvestigation(row);
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<AiopsInvestigation | null> {
    assertTenantScope(tenantId);
    const row = await this.prisma.aiopsInvestigation.findFirst({
      where: { id, tenantId },
    });
    return row ? toInvestigation(row) : null;
  }

  async listByIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<AiopsInvestigation[]> {
    assertTenantScope(tenantId);
    const rows = await this.prisma.aiopsInvestigation.findMany({
      where: { tenantId, incidentId },
      orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toInvestigation);
  }

  async findLatestByIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<AiopsInvestigation | null> {
    const rows = await this.listByIncident(tenantId, incidentId);
    return rows[0] ?? null;
  }

  async findActiveByIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<AiopsInvestigation | null> {
    assertTenantScope(tenantId);
    const row = await this.prisma.aiopsInvestigation.findFirst({
      where: {
        tenantId,
        incidentId,
        status: { in: ['QUEUED', 'PENDING', 'RUNNING', 'SYNTHESIZING'] },
      },
      orderBy: { version: 'desc' },
    });
    return row ? toInvestigation(row) : null;
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateInvestigationInput,
  ): Promise<AiopsInvestigation> {
    const current = await this.findById(tenantId, id);
    if (!current) {
      throw new TenantScopeError(
        'La investigación AIOps no existe en este tenant.',
      );
    }
    const row = await this.prisma.aiopsInvestigation.update({
      where: { id },
      data: {
        status: input.status,
        incidentLifecycle: input.incidentLifecycle,
        selectedAgents: input.selectedAgents,
        skippedAgents: input.skippedAgents,
        selectionTrace: input.selectionTrace as
          | Prisma.InputJsonValue
          | undefined,
        budgetUsed: input.budgetUsed,
        synthesisSummary: input.synthesisSummary,
        synthesisEvidence: input.synthesisEvidence as
          | Prisma.InputJsonValue
          | undefined,
        investigationResult: input.investigationResult as
          | Prisma.InputJsonValue
          | undefined,
        primaryFindingId: input.primaryFindingId,
        errorCode: input.errorCode === undefined ? undefined : input.errorCode,
        errorDetail:
          input.errorDetail === undefined ? undefined : input.errorDetail,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
      },
    });
    return toInvestigation(row);
  }
}

export { isActiveInvestigationStatus };

function toInvestigation(row: {
  id: string;
  tenantId: string;
  incidentId: string;
  status: AiopsInvestigationStatus;
  incidentLifecycle: IncidentLifecycle | null;
  trigger: string;
  version?: number;
  selectedAgents: unknown;
  skippedAgents?: unknown;
  selectionTrace?: unknown;
  budget: unknown;
  budgetUsed: unknown;
  privacyMode?: string | null;
  synthesisSummary: string | null;
  synthesisEvidence: unknown;
  investigationResult?: unknown;
  primaryFindingId: string | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  correlationId?: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AiopsInvestigation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    status: row.status,
    incidentLifecycle: row.incidentLifecycle ?? undefined,
    trigger: row.trigger,
    version: row.version ?? 1,
    selectedAgents: Array.isArray(row.selectedAgents)
      ? (row.selectedAgents as AiopsAgentType[])
      : [],
    skippedAgents: Array.isArray(row.skippedAgents)
      ? (row.skippedAgents as AiopsAgentType[])
      : [],
    selectionTrace: Array.isArray(row.selectionTrace)
      ? (row.selectionTrace as AgentSelectionTraceEntry[])
      : undefined,
    budget: isBudget(row.budget) ? row.budget : DEFAULT_INVESTIGATION_BUDGET,
    budgetUsed: isPartialBudget(row.budgetUsed) ? row.budgetUsed : undefined,
    privacyMode: row.privacyMode ?? undefined,
    synthesisSummary: row.synthesisSummary ?? undefined,
    synthesisEvidence: row.synthesisEvidence ?? undefined,
    investigationResult: isResult(row.investigationResult)
      ? row.investigationResult
      : undefined,
    primaryFindingId: row.primaryFindingId ?? undefined,
    errorCode: row.errorCode ?? undefined,
    errorDetail: row.errorDetail ?? undefined,
    correlationId: row.correlationId ?? undefined,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    createdBy: row.createdBy ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isBudget(value: unknown): value is InvestigationBudget {
  if (!value || typeof value !== 'object') return false;
  const budget = value as InvestigationBudget;
  return (
    typeof budget.maxAgents === 'number' &&
    typeof budget.maxToolCalls === 'number' &&
    typeof budget.maxLLMCalls === 'number' &&
    typeof budget.maxTokens === 'number' &&
    typeof budget.maxDurationMs === 'number'
  );
}

function isPartialBudget(
  value: unknown,
): value is Partial<InvestigationBudget> {
  return Boolean(value) && typeof value === 'object';
}

function isResult(value: unknown): value is InvestigationResult {
  return Boolean(value) && typeof value === 'object' && 'summary' in (value as object);
}
