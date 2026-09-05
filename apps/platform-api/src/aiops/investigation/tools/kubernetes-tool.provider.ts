import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { InvestigationContext } from '../../types/aiops-investigation';
import type { InvestigationPolicy } from '../../types/investigation-policy';
import { redactSecrets, type ToolCallAudit } from '../../types/tool-call';
import {
  InvestigationTelemetryPort,
  promLabel,
} from '../telemetry/investigation-telemetry.port';

export type KubernetesReadResult = {
  summary: string;
  facts: Record<string, string | number | boolean>;
  toolCalls: ToolCallAudit[];
  holmesUsed: boolean;
};

@Injectable()
export class HolmesKubernetesAdapter {
  constructor(private readonly config: ConfigService) {}

  async ask(
    context: InvestigationContext,
    investigationId: string,
  ): Promise<{
    success: boolean;
    analysis?: string;
    toolCalls: ToolCallAudit[];
  }> {
    const started = Date.now();
    const url = `${(this.config.get<string>('HOLMES_URL') ?? '').replace(/\/$/, '')}/api/chat`;
    if (!this.config.get<string>('HOLMES_URL')) {
      return {
        success: false,
        toolCalls: [
          {
            investigationId,
            agentType: 'Kubernetes',
            tool: 'holmes.chat',
            timestamp: new Date().toISOString(),
            durationMs: 0,
            success: false,
            query: 'HOLMES_URL unset',
          },
        ],
      };
    }
    const ask = redactSecrets(
      `Investigacion Kubernetes de solo lectura. tenant=${context.tenantSlug ?? ''} entity=${context.entityKey ?? ''} kind=${context.entityType ?? ''}. No ejecutes shell ni kubectl exec. Resume eventos CrashLoop/OOM/probe.`,
      800,
    );
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ask,
          model: 'openai/qwen3.5:4b',
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await response.json().catch(() => ({}))) as {
        analysis?: string;
      };
      return {
        success: response.ok && Boolean(body.analysis),
        analysis: body.analysis,
        toolCalls: [
          {
            investigationId,
            agentType: 'Kubernetes',
            tool: 'holmes.chat',
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - started,
            success: response.ok,
            query: `entity=${promLabel(context.entityKey ?? '')}`,
          },
        ],
      };
    } catch {
      return {
        success: false,
        toolCalls: [
          {
            investigationId,
            agentType: 'Kubernetes',
            tool: 'holmes.chat',
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - started,
            success: false,
            query: 'holmes unavailable',
          },
        ],
      };
    }
  }
}

@Injectable()
export class KubernetesToolProvider {
  constructor(
    private readonly telemetry: InvestigationTelemetryPort,
    private readonly holmes: HolmesKubernetesAdapter,
  ) {}

  async inspect(
    context: InvestigationContext,
    policy: InvestigationPolicy,
    investigationId: string,
  ): Promise<KubernetesReadResult> {
    const toolCalls: ToolCallAudit[] = [];
    const slug = context.tenantSlug;
    const facts: Record<string, string | number | boolean> = {};
    if (!slug) {
      return {
        summary: 'Sin tenantSlug para consultar Kubernetes de forma acotada.',
        facts,
        toolCalls,
        holmesUsed: false,
      };
    }
    const selector = this.telemetry.selector(slug);
    const query = `kube_pod_container_status_restarts_total{${selector}}`;
    const started = Date.now();
    try {
      const rows = await this.telemetry.instant(query);
      const restarts = rows.reduce(
        (sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0),
        0,
      );
      facts.podRestarts = restarts;
      facts.series = rows.length;
      toolCalls.push({
        investigationId,
        agentType: 'Kubernetes',
        tool: 'prometheus.kube_pod_restarts',
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - started,
        success: true,
        query: query.slice(0, 300),
      });
    } catch (error) {
      toolCalls.push({
        investigationId,
        agentType: 'Kubernetes',
        tool: 'prometheus.kube_pod_restarts',
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - started,
        success: false,
        query: query.slice(0, 300),
      });
      facts.prometheusError = error instanceof Error ? error.message : 'error';
    }

    let holmesUsed = false;
    if (policy.holmesKubernetesEnabled) {
      const holmes = await this.holmes.ask(context, investigationId);
      toolCalls.push(...holmes.toolCalls);
      holmesUsed = holmes.success;
      if (holmes.analysis) facts.holmesSummary = holmes.analysis.slice(0, 400);
    }

    const entity = context.entityKey ?? 'workload';
    const summary =
      typeof facts.podRestarts === 'number' && facts.podRestarts > 0
        ? `${entity}: reinicios de pod observados (${facts.podRestarts}).`
        : `${entity}: sin reinicios kube-state visibles en la ventana.`;
    return { summary, facts, toolCalls, holmesUsed };
  }
}
