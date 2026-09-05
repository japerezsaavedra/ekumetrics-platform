import { Injectable } from '@nestjs/common';
import type {
  AiopsAgentExecuteInput,
  AiopsAgentExecuteResult,
} from '../../interfaces/aiops-agent';
import { redactSecrets, type ToolCallAudit } from '../../types/tool-call';
import {
  InvestigationTelemetryPort,
  promLabel,
} from '../telemetry/investigation-telemetry.port';
import { BaseAiopsAgent } from './base.agent';

@Injectable()
export class MetricsAgent extends BaseAiopsAgent {
  readonly agentType = 'Metrics' as const;

  constructor(private readonly telemetry: InvestigationTelemetryPort) {
    super();
  }

  override canHandle(context: AiopsAgentExecuteInput['context']): boolean {
    return Boolean(context.tenantSlug);
  }

  override plan() {
    return {
      steps: ['cpu', 'latency-proxy'],
      tools: ['TelemetryClient.instant'],
    };
  }

  async execute(
    input: AiopsAgentExecuteInput,
  ): Promise<AiopsAgentExecuteResult> {
    const slug = input.context.tenantSlug;
    if (!slug) {
      return {
        finding: this.finding(input, {
          status: 'SKIPPED',
          summary: 'Sin tenantSlug para PromQL acotado.',
          evidence: [],
          skipReason: 'no_tenant_scope',
          provider: 'prometheus',
        }),
        toolCalls: [],
      };
    }
    const selector = this.telemetry.selector(slug);
    const cpuQuery = `avg(rate(system_cpu_time_seconds_total{${selector},state="user"}[5m]))`;
    const toolCalls: ToolCallAudit[] = [];
    try {
      const started = Date.now();
      const rows = await this.telemetry.instant(cpuQuery);
      toolCalls.push({
        investigationId: input.investigationId ?? '',
        agentType: 'Metrics',
        tool: 'prometheus.instant',
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - started,
        success: true,
        query: cpuQuery.slice(0, 300),
      });
      const value = rows[0]?.value;
      const entity =
        input.context.entityKey ||
        promLabel(input.context.causeKey ?? 'unknown');
      const summary = Number.isFinite(value)
        ? `CPU usuario media ${value?.toFixed(3)} (tenant ${slug}). Entidad ${entity}.`
        : `Sin muestras de CPU en Prometheus para tenant ${slug}.`;
      return {
        finding: this.finding(input, {
          status: 'COMPLETED',
          summary,
          evidence: [
            {
              kind: 'metric',
              summary,
              entityKey: input.context.entityKey,
              sourceRef: 'prometheus.instant',
              facts: { value: value ?? null, query: cpuQuery.slice(0, 180) },
            },
          ],
          confidence: Number.isFinite(value) ? 0.7 : 0.4,
          startedAt: new Date(),
          completedAt: new Date(),
          provider: 'prometheus',
          toolCalls,
        }),
        toolCalls,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'telemetry error';
      return {
        finding: this.finding(input, {
          status: 'FAILED',
          summary: 'Consulta de metricas fallida.',
          evidence: [
            {
              kind: 'metric',
              summary: redactSecrets(message, 200),
              sourceRef: 'prometheus.instant',
            },
          ],
          errors: [message],
          provider: 'prometheus',
          toolCalls,
        }),
        toolCalls,
      };
    }
  }
}
