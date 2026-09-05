import { ConflictException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MetricsService } from '../../observability/metrics.service';
import {
  EVENT_BUS,
  EventSubjects,
  buildHeaders,
  type EventBus,
} from '../../messaging';
import {
  AGENT_ORCHESTRATOR,
  type AgentOrchestrator,
  type OrchestratorRunInput,
} from '../interfaces/agent-orchestrator';
import type { AiopsAgent } from '../interfaces/aiops-agent';
import { AgentFindingRepository } from '../persistence/agent-finding.repository';
import { InvestigationRepository } from '../persistence/investigation.repository';
import type { AgentFinding } from '../types/agent-finding';
import type { AiopsAgentType } from '../types/aiops-agent-type';
import type {
  AiopsInvestigation,
  AiopsInvestigationStatus,
  InvestigationBudget,
  InvestigationContext,
} from '../types/aiops-investigation';
import {
  DEFAULT_INVESTIGATION_BUDGET,
  isActiveInvestigationStatus,
} from '../types/aiops-investigation';
import { effectiveLlmBudget } from '../types/investigation-policy';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IncidentEnrichmentService } from '../enrichment/incident-enrichment.service';
import { AgentSelectionService } from './agent-selection.service';
import { KubernetesAgent } from './agents/kubernetes.agent';
import { SynthesisAgent } from './agents/synthesis.agent';
import { InvestigationContextBuilder } from './investigation-context.builder';
import { InvestigationPolicyService } from './investigation-policy.service';
import { InvestigationMetrics } from './investigation.metrics';
import { synthesizeDeterministic } from './synthesis/deterministic-synthesis';

export const AIOPS_AGENTS = 'AIOPS_AGENTS';
export const INVESTIGATION_PRODUCED_BY = 'aiops-investigation-orchestrator';

@Injectable()
export class AgentOrchestratorService implements AgentOrchestrator {
  private readonly logger = new Logger(AgentOrchestratorService.name);

  constructor(
    private readonly investigations: InvestigationRepository,
    private readonly findings: AgentFindingRepository,
    private readonly policyService: InvestigationPolicyService,
    private readonly selection: AgentSelectionService,
    private readonly metrics: InvestigationMetrics,
    @Inject(AIOPS_AGENTS) private readonly agents: AiopsAgent[],
    private readonly synthesisAgent: SynthesisAgent,
    private readonly kubernetesAgent: KubernetesAgent,
    private readonly contextBuilder: InvestigationContextBuilder,
    private readonly prisma: PrismaService,
    @Optional() private readonly enrichment?: IncidentEnrichmentService,
    @Optional() @Inject(EVENT_BUS) private readonly eventBus?: EventBus,
    @Optional() platformMetrics?: MetricsService,
  ) {
    platformMetrics?.registerContributor('aiops-investigation', () =>
      this.metrics.render(),
    );
  }

  select(context: InvestigationContext): AiopsAgentType[] {
    return this.selection.select(
      context,
      {
        tenantId: context.tenantId,
        mode: 'MANUAL',
        privacyMode: 'AI_DISABLED',
        enabledAgentTypes: [
          'Rca',
          'Metrics',
          'Logs',
          'Kubernetes',
          'Topology',
          'Synthesis',
        ],
        holmesKubernetesEnabled: false,
        budget: {
          maxAgents: 6,
          maxToolCalls: 20,
          maxLLMCalls: 0,
          maxTokens: 0,
          maxDurationMs: 120_000,
          maxConcurrentAgents: 5,
          agentTimeoutMs: 30_000,
        },
      },
      DEFAULT_INVESTIGATION_BUDGET,
    ).selected;
  }

  async trigger(input: OrchestratorRunInput): Promise<AiopsInvestigation> {
    const created = await this.start(input);
    void this.execute(created.id, created.tenantId).catch((error) => {
      this.logger.log(
        `aiops AgentOrchestrator background failed tenantId=${created.tenantId} incidentId=${created.incidentId} error=${error instanceof Error ? error.message : 'unknown'}`,
      );
    });
    return created;
  }

  async run(input: OrchestratorRunInput): Promise<AiopsInvestigation> {
    const created = await this.start(input);
    return this.execute(created.id, created.tenantId);
  }

  async cancel(
    tenantId: string,
    incidentId: string,
  ): Promise<AiopsInvestigation | null> {
    const active = await this.investigations.findActiveByIncident(
      tenantId,
      incidentId,
    );
    if (!active) return null;
    const updated = await this.investigations.update(tenantId, active.id, {
      status: 'CANCELLED',
      completedAt: new Date(),
      errorCode: 'CANCELLED',
    });
    const open = await this.findings.listByInvestigation(tenantId, active.id);
    await Promise.all(
      open
        .filter((item) => !['COMPLETED', 'FAILED', 'SKIPPED', 'TIMEOUT'].includes(item.status))
        .map((item) =>
          this.findings.update(tenantId, item.id, {
            status: item.status === 'PENDING' ? 'SKIPPED' : 'TIMEOUT',
            skipReason: 'cancelled',
            completedAt: new Date(),
          }),
        ),
    );
    return updated;
  }

  private async start(
    input: OrchestratorRunInput,
  ): Promise<AiopsInvestigation> {
    const policy = await this.policyService.resolve(input.tenantId);
    const active = await this.investigations.findActiveByIncident(
      input.tenantId,
      input.incidentId,
    );
    if (active) {
      throw new ConflictException(
        'Ya hay una investigacion AIOps en curso para este incidente.',
      );
    }
    const latest = await this.investigations.findLatestByIncident(
      input.tenantId,
      input.incidentId,
    );
    if (input.retry && latest && isActiveInvestigationStatus(latest.status)) {
      throw new ConflictException(
        'No se puede reintentar una investigacion en curso.',
      );
    }
    const version = (latest?.version ?? 0) + 1;
    const context = input.context as InvestigationContext;
    const budget = mergeBudget(policy.budget, input.budget, policy.privacyMode);
    const picked = this.selection.select(context, policy, budget);
    let created: AiopsInvestigation;
    try {
      created = await this.investigations.create(input.tenantId, {
        tenantId: input.tenantId,
        incidentId: input.incidentId,
        status: 'PENDING',
        trigger: input.trigger ?? 'operator',
        version,
        selectedAgents: picked.selected,
        skippedAgents: picked.skipped,
        selectionTrace: picked.trace,
        budget,
        privacyMode: policy.privacyMode,
        correlationId: input.correlationId,
        createdBy: input.createdBy,
        startedAt: new Date(),
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Ya hay una investigacion AIOps en curso para este incidente.',
        );
      }
      throw error;
    }
    await this.publish(
      EventSubjects.AIOPS_INVESTIGATION_STARTED,
      created,
      `${input.tenantId}:aiops.investigation.started:${input.incidentId}:${version}`,
    );
    return created;
  }

  async execute(
    investigationId: string,
    tenantId: string,
  ): Promise<AiopsInvestigation> {
    const started = Date.now();
    let current = await this.investigations.findById(tenantId, investigationId);
    if (!current) {
      throw new Error('Investigacion no encontrada.');
    }
    current = await this.investigations.update(tenantId, investigationId, {
      status: 'RUNNING',
    });
    const context = await this.loadContext(tenantId, current.incidentId);
    const policy = await this.policyService.resolve(tenantId);
    this.kubernetesAgent.bindPolicy(policy);

    const deadline = Date.now() + (current.budget.maxDurationMs || 120_000);
    const timeoutMs = current.budget.agentTimeoutMs ?? 30_000;
    const specialists = current.selectedAgents.filter(
      (type) => type !== 'Synthesis',
    );

    for (const skipped of current.skippedAgents) {
      await this.findings.create(tenantId, {
        tenantId,
        incidentId: current.incidentId,
        investigationId,
        agentType: skipped,
        status: 'SKIPPED',
        summary: `AIOps Agent ${skipped} no seleccionado.`,
        evidence: [],
        skipReason:
          current.selectionTrace?.find((item) => item.agentType === skipped)
            ?.reason ?? 'skipped',
      });
    }

    const executed: AgentFinding[] = [];
    await Promise.all(
      specialists.map(async (agentType) => {
        const agent = this.agents.find((item) => item.agentType === agentType);
        if (!agent) return;
        const live = await this.investigations.findById(tenantId, investigationId);
        if (!live || live.status === 'CANCELLED') return;
        if (Date.now() > deadline) {
          const finding = await this.findings.create(tenantId, {
            tenantId,
            incidentId: current.incidentId,
            investigationId,
            agentType,
            status: 'TIMEOUT',
            summary: `${agentType} no ejecuto: presupuesto de tiempo agotado.`,
            evidence: [
              {
                kind: 'timeout',
                summary: 'investigationTimeoutMs exceeded',
              },
            ],
            skipReason: 'investigation_timeout',
          });
          executed.push(finding);
          this.metrics.recordAgent(agentType, 'TIMEOUT', 0);
          return;
        }
        const agentStarted = Date.now();
        const persisted = await this.findings.create(tenantId, {
          tenantId,
          incidentId: current.incidentId,
          investigationId,
          agentType,
          status: 'PENDING',
          summary: '',
          evidence: [],
          startedAt: new Date(),
        });
        await this.publishAgent(current, agentType, 'RUNNING');
        try {
          const result = await withTimeout(
            agent.execute({
              tenantId,
              incidentId: current.incidentId,
              investigationId,
              context,
              budget: {
                maxToolCalls: current.budget.maxToolCalls,
                timeoutMs,
              },
            }),
            timeoutMs,
          );
          if (result.finding.status !== 'SKIPPED') {
            await this.findings.update(tenantId, persisted.id, {
              status: 'RUNNING',
            });
          }
          const saved = await this.findings.update(tenantId, persisted.id, {
            status: result.finding.status,
            summary: result.finding.summary,
            evidence: result.finding.evidence,
            confidence: result.finding.confidence,
            provider: result.finding.provider,
            model: result.finding.model,
            toolCalls: result.toolCalls,
            errors: result.finding.errors,
            skipReason: result.finding.skipReason,
            completedAt: new Date(),
          });
          executed.push(saved);
          this.metrics.recordAgent(
            agentType,
            saved.status,
            (Date.now() - agentStarted) / 1000,
          );
          result.toolCalls.forEach((call) =>
            this.metrics.recordToolCall(call.durationMs / 1000),
          );
        } catch (error) {
          try {
            await this.findings.update(tenantId, persisted.id, {
              status: 'RUNNING',
            });
          } catch {
            /* already terminal or still pending */
          }
          const timeout = error instanceof AgentTimeoutError;
          const saved = await this.findings.update(tenantId, persisted.id, {
            status: timeout ? 'TIMEOUT' : 'FAILED',
            summary: timeout
              ? `${agentType} timeout`
              : `${agentType} fallo: ${error instanceof Error ? error.message : 'error'}`,
            evidence: [
              {
                kind: 'error',
                summary: error instanceof Error ? error.message : 'error',
              },
            ],
            errors: [error instanceof Error ? error.message : 'error'],
            completedAt: new Date(),
          });
          executed.push(saved);
          this.metrics.recordAgent(
            agentType,
            saved.status,
            (Date.now() - agentStarted) / 1000,
          );
        }
        await this.publishAgent(
          current,
          agentType,
          executed[executed.length - 1]?.status ?? 'FAILED',
        );
      }),
    );

    const allFindings = [
      ...executed,
      ...(await this.findings.listByInvestigation(tenantId, investigationId)),
    ];
    const unique = uniqueFindings(allFindings);
    const specialistCount = specialists.length;
    this.synthesisAgent.bind(unique, specialistCount, policy);
    await this.investigations.update(tenantId, investigationId, {
      status: 'SYNTHESIZING',
    });
    let synthesisFinding: AgentFinding | undefined;
    try {
      const synth = await this.synthesisAgent.execute({
        tenantId,
        incidentId: current.incidentId,
        investigationId,
        context,
        budget: { maxToolCalls: 0, timeoutMs },
      });
      synthesisFinding = await this.findings.create(tenantId, {
        tenantId,
        incidentId: current.incidentId,
        investigationId,
        agentType: 'Synthesis',
        status: synth.finding.status,
        summary: synth.finding.summary,
        evidence: synth.finding.evidence,
        confidence: synth.finding.confidence,
        provider: synth.finding.provider,
        model: synth.finding.model,
        startedAt: new Date(),
        completedAt: new Date(),
        skipReason: synth.finding.skipReason,
      });
    } catch (error) {
      this.logger.log(
        `aiops SynthesisAgent failed tenantId=${tenantId} investigationId=${investigationId} error=${error instanceof Error ? error.message : 'unknown'}`,
      );
    }

    const result = synthesizeDeterministic({
      context,
      findings: unique,
      selectedSpecialists: Math.max(1, specialistCount),
    });
    if (synthesisFinding?.summary) {
      result.summary = synthesisFinding.summary;
      result.probableRootCause = synthesisFinding.summary;
      if (synthesisFinding.confidence != null) {
        result.confidence = synthesisFinding.confidence;
      }
      result.provider = synthesisFinding.provider;
      result.model = synthesisFinding.model;
      if (synthesisFinding.provider && synthesisFinding.provider !== 'deterministic_synthesis') {
        result.synthesisMode = 'llm';
      }
    }

    const specialistTypes = specialists as Exclude<AiopsAgentType, 'Synthesis'>[];
    const statuses = unique
      .filter((item) => item.agentType !== 'Synthesis')
      .filter((item) =>
        specialistTypes.includes(item.agentType as Exclude<AiopsAgentType, 'Synthesis'>),
      )
      .map((item) => item.status);
    const anyFailed = statuses.some(
      (status) => status === 'FAILED' || status === 'TIMEOUT',
    );
    const allFailed =
      statuses.length > 0 &&
      statuses.every((status) => status === 'FAILED' || status === 'TIMEOUT');
    const timedOut = Date.now() > deadline;
    let finalStatus: AiopsInvestigationStatus = 'COMPLETED';
    if (timedOut && allFailed) finalStatus = 'TIMEOUT';
    else if (allFailed) finalStatus = 'FAILED';
    else if (anyFailed) finalStatus = 'PARTIAL';

    const completed = await this.investigations.update(tenantId, investigationId, {
      status: finalStatus,
      completedAt: new Date(),
      synthesisSummary: result.summary,
      investigationResult: result,
      primaryFindingId: synthesisFinding?.id ?? unique.find((item) => item.agentType === 'Rca')?.id,
    });

    try {
      await this.enrichment?.applyInvestigationCompleted?.(
        tenantId,
        current.incidentId,
        {
          investigationId,
          version: current.version,
          status: finalStatus,
          confidence: result.confidence,
          summary: result.summary,
        },
      );
    } catch (error) {
      this.logger.log(
        `aiops investigation enrichment patch failed tenantId=${tenantId} incidentId=${current.incidentId} error=${error instanceof Error ? error.message : 'unknown'}`,
      );
    }

    this.metrics.recordInvestigation(
      finalStatus,
      (Date.now() - started) / 1000,
    );
    if (finalStatus === 'TIMEOUT') {
      this.metrics.recordBudgetExhausted();
    }
    const subject =
      finalStatus === 'FAILED' || finalStatus === 'TIMEOUT'
        ? EventSubjects.AIOPS_INVESTIGATION_FAILED
        : EventSubjects.AIOPS_INVESTIGATION_COMPLETED;
    await this.publish(
      subject,
      completed,
      `${tenantId}:aiops.investigation.${finalStatus.toLowerCase()}:${current.incidentId}:${current.version}`,
    );
    return completed;
  }

  private async loadContext(
    tenantId: string,
    incidentId: string,
  ): Promise<InvestigationContext> {
    const incident = await this.prisma.incident.findFirst({
      where: { id: incidentId, tenantId },
    });
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId },
    });
    const enrichment = this.enrichment
      ? await this.enrichment.find(tenantId, incidentId)
      : null;
    if (!incident) {
      return { tenantId, incidentId, tenantSlug: tenant?.slug };
    }
    return this.contextBuilder.build(incident, enrichment, tenant?.slug);
  }

  private async publish(
    subject: string,
    investigation: AiopsInvestigation,
    idempotencyKey: string,
  ): Promise<void> {
    if (!this.eventBus) return;
    try {
      await this.eventBus.publish(subject, {
        payload: {
          tenantId: investigation.tenantId,
          incidentId: investigation.incidentId,
          investigationId: investigation.id,
          version: investigation.version,
          status: investigation.status,
          trigger: investigation.trigger,
        },
        headers: buildHeaders({
          tenantId: investigation.tenantId,
          incidentId: investigation.incidentId,
          correlationId: investigation.correlationId ?? investigation.id,
          producedBy: INVESTIGATION_PRODUCED_BY,
        }),
        idempotencyKey,
      });
    } catch (error) {
      this.logger.log(
        `aiops investigation publish skipped subject=${subject} tenantId=${investigation.tenantId} error=${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  private async publishAgent(
    investigation: AiopsInvestigation,
    agentType: string,
    status: string,
  ): Promise<void> {
    if (!this.eventBus) return;
    const subject =
      status === 'RUNNING'
        ? EventSubjects.AIOPS_AGENT_STARTED
        : EventSubjects.AIOPS_AGENT_COMPLETED;
    try {
      await this.eventBus.publish(subject, {
        payload: {
          tenantId: investigation.tenantId,
          incidentId: investigation.incidentId,
          investigationId: investigation.id,
          agentType,
          status,
        },
        headers: buildHeaders({
          tenantId: investigation.tenantId,
          incidentId: investigation.incidentId,
          correlationId: investigation.correlationId ?? investigation.id,
          producedBy: INVESTIGATION_PRODUCED_BY,
        }),
        idempotencyKey: `${investigation.tenantId}:aiops.agent.${status.toLowerCase()}:${investigation.id}:${agentType}`,
      });
    } catch {
      return;
    }
  }
}

class AgentTimeoutError extends Error {
  constructor() {
    super('AIOps Agent timeout');
    this.name = 'AgentTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgentTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function mergeBudget(
  policyBudget: InvestigationBudget & {
    maxConcurrentAgents: number;
    agentTimeoutMs: number;
  },
  override: InvestigationBudget | undefined,
  privacyMode: string,
): InvestigationBudget {
  const merged = { ...DEFAULT_INVESTIGATION_BUDGET, ...policyBudget, ...override };
  merged.maxLLMCalls = effectiveLlmBudget(
    privacyMode as 'AI_DISABLED' | 'LOCAL_ONLY' | 'CLOUD_REDACTED' | 'CLOUD_ALLOWED',
    merged.maxLLMCalls,
  );
  return merged;
}

function uniqueFindings(rows: AgentFinding[]): AgentFinding[] {
  const byType = new Map<string, AgentFinding>();
  for (const row of rows) {
    byType.set(row.agentType, row);
  }
  return [...byType.values()];
}

export { AGENT_ORCHESTRATOR };
