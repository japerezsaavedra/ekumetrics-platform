import { Injectable } from '@nestjs/common';
import type {
  AiopsAgentExecuteInput,
  AiopsAgentExecuteResult,
} from '../../interfaces/aiops-agent';
import { redactSecrets, type ToolCallAudit } from '../../types/tool-call';
import { InvestigationTelemetryPort } from '../telemetry/investigation-telemetry.port';
import { BaseAiopsAgent } from './base.agent';

const MAX_LINES = 40;

@Injectable()
export class LogsAgent extends BaseAiopsAgent {
  readonly agentType = 'Logs' as const;

  constructor(private readonly telemetry: InvestigationTelemetryPort) {
    super();
  }

  override canHandle(context: AiopsAgentExecuteInput['context']): boolean {
    return Boolean(context.tenantSlug);
  }

  override plan() {
    return { steps: ['error-logs', 'pattern'], tools: ['TelemetryClient.loki'] };
  }

  async execute(
    input: AiopsAgentExecuteInput,
  ): Promise<AiopsAgentExecuteResult> {
    const slug = input.context.tenantSlug;
    if (!slug) {
      return {
        finding: this.finding(input, {
          status: 'SKIPPED',
          summary: 'Sin tenantSlug para LogQL acotado.',
          evidence: [],
          skipReason: 'no_tenant_scope',
          provider: 'loki',
        }),
        toolCalls: [],
      };
    }
    const seconds = this.telemetry.windowSeconds(
      input.context.windowStart,
      input.context.windowEnd,
    );
    const query = `{tenant_id="${slug}"} |= "error"`;
    const toolCalls: ToolCallAudit[] = [];
    try {
      const started = Date.now();
      const lines = await this.telemetry.lokiLines(query, seconds, MAX_LINES);
      toolCalls.push({
        investigationId: input.investigationId ?? '',
        agentType: 'Logs',
        tool: 'loki.lines',
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - started,
        success: true,
        query,
      });
      const redacted = lines.map((item) => redactSecrets(item.line, 240));
      const templates = countTemplates(redacted);
      const top = [...templates.entries()].sort((a, b) => b[1] - a[1])[0];
      const first = redacted[redacted.length - 1];
      const summary = lines.length
        ? `${lines.length} lineas error; patron mas frecuente x${top?.[1] ?? 0}.`
        : 'Sin lineas error en Loki para la ventana.';
      return {
        finding: this.finding(input, {
          status: 'COMPLETED',
          summary,
          evidence: [
            {
              kind: 'log',
              summary,
              entityKey: input.context.entityKey,
              sourceRef: 'loki.lines',
              facts: {
                lines: lines.length,
                first: first ?? '',
                topTemplate: top?.[0] ?? '',
              },
            },
          ],
          confidence: lines.length ? 0.72 : 0.35,
          startedAt: new Date(),
          completedAt: new Date(),
          provider: 'loki',
          toolCalls,
        }),
        toolCalls,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'loki error';
      return {
        finding: this.finding(input, {
          status: 'FAILED',
          summary: 'Consulta de logs fallida.',
          evidence: [
            {
              kind: 'log',
              summary: redactSecrets(message, 200),
              sourceRef: 'loki.lines',
            },
          ],
          errors: [message],
          provider: 'loki',
          toolCalls,
        }),
        toolCalls,
      };
    }
  }
}

function countTemplates(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const template = line.replace(/\d+/g, '#').slice(0, 80);
    counts.set(template, (counts.get(template) ?? 0) + 1);
  }
  return counts;
}
