import { Inject, Injectable } from '@nestjs/common';
import type {
  AiopsAgentExecuteInput,
  AiopsAgentExecuteResult,
} from '../../interfaces/aiops-agent';
import {
  TOPOLOGY_REPOSITORY,
  type TopologyRepository,
} from '../../topology.repository';
import { BaseAiopsAgent } from './base.agent';

@Injectable()
export class TopologyAgent extends BaseAiopsAgent {
  readonly agentType = 'Topology' as const;

  constructor(
    @Inject(TOPOLOGY_REPOSITORY) private readonly topology: TopologyRepository,
  ) {
    super();
  }

  override canHandle(context: AiopsAgentExecuteInput['context']): boolean {
    return Boolean(
      context.causeKey ||
        context.entityKey ||
        context.needsBlastRadius ||
        (context.blastRadius && context.blastRadius.entityKeys.length > 0),
    );
  }

  override plan() {
    return {
      steps: ['ancestors', 'blast-radius'],
      tools: ['TopologyRepository'],
    };
  }

  async execute(
    input: AiopsAgentExecuteInput,
  ): Promise<AiopsAgentExecuteResult> {
    const origin =
      input.context.causeKey ||
      input.context.entityKey ||
      input.context.blastRadius?.entityKeys[0];
    if (!origin) {
      return {
        finding: this.finding(input, {
          status: 'SKIPPED',
          summary: 'Sin entidad de topologia.',
          evidence: [],
          skipReason: 'no_topology_scope',
          provider: 'topology_repository',
        }),
        toolCalls: [],
      };
    }
    const ancestor = await this.topology.getCommonAncestor(input.tenantId, [
      origin,
      ...(input.context.blastRadius?.entityKeys ?? []).slice(0, 8),
    ]);
    const dependents = await this.topology.getDependents(
      input.tenantId,
      origin,
      { hops: 3 },
    );
    const blastCount =
      input.context.blastRadius?.entityCount ?? dependents.length;
    const evidence = [
      {
        kind: 'topology',
        summary: ancestor
          ? `Ancestro comun ${ancestor.entityKey} (${ancestor.kind}).`
          : `Origen ${origin} sin ancestro comun adicional.`,
        entityKey: ancestor?.entityKey ?? origin,
        sourceRef: 'TopologyRepository.getCommonAncestor',
      },
      {
        kind: 'blast_radius',
        summary: `Radio de impacto: ${blastCount} entidades.`,
        entityKey: origin,
        sourceRef: 'IncidentEnrichment.blastRadius',
        facts: { entityCount: blastCount },
      },
    ];
    return {
      finding: this.finding(input, {
        status: 'COMPLETED',
        summary: `Topologia: ${origin} afecta ${blastCount} entidades.`,
        evidence,
        confidence: ancestor ? 0.8 : 0.55,
        startedAt: new Date(),
        completedAt: new Date(),
        provider: 'topology_repository',
      }),
      toolCalls: [
        {
          investigationId: input.investigationId ?? '',
          agentType: 'Topology',
          tool: 'topology.getCommonAncestor',
          timestamp: new Date().toISOString(),
          durationMs: 0,
          success: true,
          query: origin,
        },
      ],
    };
  }
}
