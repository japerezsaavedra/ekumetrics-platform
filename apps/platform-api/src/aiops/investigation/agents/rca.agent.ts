import { Inject, Injectable } from '@nestjs/common';
import { RCA_ENGINE, type RcaEngine } from '../../interfaces/rca-engine';
import type {
  AiopsAgentExecuteInput,
  AiopsAgentExecuteResult,
} from '../../interfaces/aiops-agent';
import type { InvestigationContext } from '../../types/aiops-investigation';
import { BaseAiopsAgent } from './base.agent';

@Injectable()
export class RcaAgent extends BaseAiopsAgent {
  readonly agentType = 'Rca' as const;

  constructor(@Inject(RCA_ENGINE) private readonly rca: RcaEngine) {
    super();
  }

  override canHandle(): boolean {
    return true;
  }

  override plan() {
    return { steps: ['project-snapshot-or-propose'], tools: ['RcaEngine'] };
  }

  async execute(
    input: AiopsAgentExecuteInput,
  ): Promise<AiopsAgentExecuteResult> {
    const snapshot = input.context.deterministicRca;
    if (snapshot?.candidates?.length) {
      const primary = snapshot.candidates[0];
      const evidence = snapshot.candidates.slice(0, 5).map((item) => ({
        kind: 'rca',
        summary: item.hypothesis,
        entityKey: item.entityKey,
        sourceRef: 'IncidentEnrichment.rca',
        facts: { rank: item.rank, confidence: item.confidence },
      }));
      return {
        finding: this.finding(input, {
          status: 'COMPLETED',
          summary: primary.hypothesis,
          evidence,
          confidence: primary.confidence,
          startedAt: new Date(),
          completedAt: new Date(),
          provider: 'deterministic_rca',
        }),
        toolCalls: [],
      };
    }
    const candidates = await this.rca.propose({
      tenantId: input.tenantId,
      incidentId: input.incidentId,
      investigationId: input.investigationId,
      entityKeys: entityKeys(input.context),
      preliminaryCauseKey: input.context.causeKey,
    });
    const primary = candidates[0];
    if (!primary) {
      return {
        finding: this.finding(input, {
          status: 'SKIPPED',
          summary: 'RcaEngine no devolvio candidatos.',
          evidence: [],
          skipReason: 'no_rca_candidates',
          provider: 'deterministic_rca',
        }),
        toolCalls: [],
      };
    }
    const evidence = (primary.evidence ?? []).map((item) => ({
      kind: item.kind,
      summary: item.summary,
      entityKey: item.entityKey,
      sourceRef: 'RcaEngine.propose',
    }));
    return {
      finding: this.finding(input, {
        status: 'COMPLETED',
        summary: primary.hypothesis,
        evidence:
          evidence.length > 0
            ? evidence
            : [
                {
                  kind: 'rca',
                  summary: primary.hypothesis,
                  entityKey: primary.entityId ?? primary.entityKey,
                  sourceRef: 'RcaEngine.propose',
                },
              ],
        confidence: primary.confidence,
        startedAt: new Date(),
        completedAt: new Date(),
        provider: 'deterministic_rca',
      }),
      toolCalls: [],
    };
  }
}

function entityKeys(context: InvestigationContext): string[] {
  const keys = [
    context.entityKey,
    context.causeKey,
    ...(context.affectedEntities ?? []).map((item) => item.entityKey),
  ].filter((item): item is string => Boolean(item));
  return [...new Set(keys)];
}
