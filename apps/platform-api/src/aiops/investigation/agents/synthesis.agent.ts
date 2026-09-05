import { Injectable } from '@nestjs/common';
import type { AgentFinding } from '../../types/agent-finding';
import type {
  AiopsAgentExecuteInput,
  AiopsAgentExecuteResult,
} from '../../interfaces/aiops-agent';
import type { InvestigationPolicy } from '../../types/investigation-policy';
import { AiCompletionPort } from '../ai/ai-completion.port';
import { synthesizeDeterministic } from '../synthesis/deterministic-synthesis';
import {
  investigationConfidence,
} from '../synthesis/confidence';
import { BaseAiopsAgent } from './base.agent';

@Injectable()
export class SynthesisAgent extends BaseAiopsAgent {
  readonly agentType = 'Synthesis' as const;
  private findings: AgentFinding[] = [];
  private selectedSpecialists = 1;
  private policy: InvestigationPolicy | null = null;

  constructor(private readonly completion: AiCompletionPort) {
    super();
  }

  bind(
    findings: AgentFinding[],
    selectedSpecialists: number,
    policy: InvestigationPolicy,
  ): this {
    this.findings = findings;
    this.selectedSpecialists = selectedSpecialists;
    this.policy = policy;
    return this;
  }

  override plan() {
    return { steps: ['merge-findings', 'optional-llm'], tools: [] };
  }

  async execute(
    input: AiopsAgentExecuteInput,
  ): Promise<AiopsAgentExecuteResult> {
    const usable = this.findings.filter((item) => item.status !== 'SKIPPED');
    if (usable.length === 0) {
      return {
        finding: this.finding(input, {
          status: 'SKIPPED',
          summary: 'Sin findings para sintetizar.',
          evidence: [],
          skipReason: 'no_findings',
          provider: 'deterministic_synthesis',
        }),
        toolCalls: [],
      };
    }
    const deterministic = synthesizeDeterministic({
      context: input.context,
      findings: this.findings,
      selectedSpecialists: this.selectedSpecialists,
    });
    let result = deterministic;
    let usedLlm = false;
    let llmAgreed: boolean | null = null;
    const privacy = this.policy?.privacyMode ?? 'AI_DISABLED';
    const maxLlm = this.policy?.budget.maxLLMCalls ?? 0;
    if (privacy !== 'AI_DISABLED' && maxLlm > 0) {
      const llm = await this.completion.complete({
        prompt: boundedPrompt(input, this.findings, deterministic.summary),
        privacyMode: privacy,
        maxTokens: this.policy?.budget.maxTokens ?? 512,
      });
      if (llm?.text) {
        usedLlm = true;
        llmAgreed = llm.text
          .toLowerCase()
          .includes((deterministic.probableRootCause ?? '').toLowerCase().slice(0, 24));
        result = {
          ...deterministic,
          summary: llm.text.slice(0, 1_200),
          provider: llm.provider,
          model: llm.model,
          redactionApplied: llm.redactionApplied,
          synthesisMode: 'llm',
          confidence: investigationConfidence({
            deterministicConfidence: deterministic.confidence,
            findings: this.findings,
            selectedSpecialists: this.selectedSpecialists,
            usedLlm: true,
            llmAgreed,
          }),
        };
      }
    }
    return {
      finding: this.finding(input, {
        status: 'COMPLETED',
        summary: result.probableRootCause,
        evidence:
          result.supportingEvidence.length > 0
            ? result.supportingEvidence.slice(0, 8).map((summary) => ({
                kind: 'synthesis',
                summary,
                sourceRef: usedLlm ? 'llm_synthesis' : 'deterministic_synthesis',
              }))
            : [
                {
                  kind: 'synthesis',
                  summary: result.probableRootCause,
                  sourceRef: usedLlm
                    ? 'llm_synthesis'
                    : 'deterministic_synthesis',
                },
              ],
        confidence: result.confidence,
        startedAt: new Date(),
        completedAt: new Date(),
        provider: result.provider ?? 'deterministic_synthesis',
        model: result.model,
      }),
      toolCalls: [],
    };
  }
}

function boundedPrompt(
  input: AiopsAgentExecuteInput,
  findings: AgentFinding[],
  deterministic: string,
): string {
  const lines = findings
    .filter((item) => item.status === 'COMPLETED')
    .map(
      (item) =>
        `${item.agentType}: ${item.summary} conf=${item.confidence ?? 0}`,
    );
  return [
    `Incidente ${input.incidentId} tenant ${input.tenantId}.`,
    `RCA determinista: ${deterministic}`,
    'Findings:',
    ...lines.slice(0, 12),
    'Devuelve un parrafo con causa probable. No inventes evidencia.',
  ].join('\n');
}
