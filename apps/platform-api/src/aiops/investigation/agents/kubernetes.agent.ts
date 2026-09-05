import { Injectable } from '@nestjs/common';
import type {
  AiopsAgentExecuteInput,
  AiopsAgentExecuteResult,
} from '../../interfaces/aiops-agent';
import type { InvestigationPolicy } from '../../types/investigation-policy';
import { KubernetesToolProvider } from '../tools/kubernetes-tool.provider';
import { BaseAiopsAgent } from './base.agent';

@Injectable()
export class KubernetesAgent extends BaseAiopsAgent {
  readonly agentType = 'Kubernetes' as const;
  private policy: InvestigationPolicy | null = null;

  constructor(private readonly tools: KubernetesToolProvider) {
    super();
  }

  bindPolicy(policy: InvestigationPolicy): this {
    this.policy = policy;
    return this;
  }

  override canHandle(context: AiopsAgentExecuteInput['context']): boolean {
    const kinds = [
      context.entityType,
      ...(context.affectedEntityKinds ?? []),
    ].map((item) => (item ?? '').toUpperCase());
    return kinds.some((kind) =>
      ['K8S_POD', 'DEPLOYMENT', 'NODE', 'STATEFULSET', 'DAEMONSET'].includes(
        kind,
      ),
    );
  }

  override plan() {
    return {
      steps: ['kube-state', 'holmes-optional'],
      tools: ['KubernetesReadTools', 'HolmesProvider'],
    };
  }

  async execute(
    input: AiopsAgentExecuteInput,
  ): Promise<AiopsAgentExecuteResult> {
    if (!this.canHandle(input.context)) {
      return {
        finding: this.finding(input, {
          status: 'SKIPPED',
          summary: 'Sin entidades Kubernetes.',
          evidence: [],
          skipReason: 'no_k8s_entity',
          provider: 'kubernetes_read',
        }),
        toolCalls: [],
      };
    }
    const policy = this.policy ?? {
      tenantId: input.tenantId,
      mode: 'MANUAL',
      privacyMode: 'AI_DISABLED',
      enabledAgentTypes: [],
      holmesKubernetesEnabled: false,
      budget: {
        maxAgents: 6,
        maxToolCalls: 20,
        maxLLMCalls: 0,
        maxTokens: 0,
        maxDurationMs: 120_000,
        maxConcurrentAgents: 5,
        agentTimeoutMs: 20_000,
      },
    };
    try {
      const result = await this.tools.inspect(
        input.context,
        policy,
        input.investigationId ?? '',
      );
      return {
        finding: this.finding(input, {
          status: 'COMPLETED',
          summary: result.summary,
          evidence: [
            {
              kind: 'kubernetes',
              summary: result.summary,
              entityKey: input.context.entityKey,
              sourceRef: 'KubernetesToolProvider',
              facts: result.facts,
            },
          ],
          confidence: result.holmesUsed ? 0.7 : 0.58,
          startedAt: new Date(),
          completedAt: new Date(),
          provider: result.holmesUsed ? 'holmes_optional' : 'kubernetes_read',
          toolCalls: result.toolCalls,
        }),
        toolCalls: result.toolCalls,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'k8s error';
      return {
        finding: this.finding(input, {
          status: 'FAILED',
          summary: 'Herramientas Kubernetes de solo lectura fallaron.',
          evidence: [
            {
              kind: 'kubernetes',
              summary: message,
              sourceRef: 'KubernetesToolProvider',
            },
          ],
          errors: [message],
          provider: 'kubernetes_read',
        }),
        toolCalls: [],
      };
    }
  }
}
