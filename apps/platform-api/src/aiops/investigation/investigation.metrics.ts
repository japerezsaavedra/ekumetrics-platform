import { Injectable } from '@nestjs/common';
import { AiopsMetricNames } from '../contracts/metrics';

const DURATION_BUCKETS = [0.5, 1, 2.5, 5, 10, 30, 60, 120];

@Injectable()
export class InvestigationMetrics {
  private investigations = new Map<string, number>();
  private failures = 0;
  private budgetExhausted = 0;
  private durationCount = 0;
  private durationSum = 0;
  private readonly durationBuckets = DURATION_BUCKETS.map(() => 0);
  private readonly agentExec = new Map<string, number>();
  private readonly agentFail = new Map<string, number>();
  private readonly agentTimeout = new Map<string, number>();
  private readonly agentDuration = new Map<string, { count: number; sum: number }>();
  private toolCalls = 0;
  private toolDurationSum = 0;
  private llmCalls = new Map<string, number>();
  private llmFail = 0;
  private llmDurationSum = 0;
  private llmDurationCount = 0;

  recordInvestigation(outcome: string, durationSeconds: number): void {
    this.investigations.set(
      outcome,
      (this.investigations.get(outcome) ?? 0) + 1,
    );
    if (outcome === 'FAILED' || outcome === 'TIMEOUT') {
      this.failures += 1;
    }
    const seconds = Math.max(0, durationSeconds);
    this.durationCount += 1;
    this.durationSum += seconds;
    DURATION_BUCKETS.forEach((bucket, index) => {
      if (seconds <= bucket) this.durationBuckets[index] += 1;
    });
  }

  recordBudgetExhausted(): void {
    this.budgetExhausted += 1;
  }

  recordAgent(agentType: string, outcome: string, durationSeconds: number): void {
    const key = `${agentType}:${outcome}`;
    this.agentExec.set(key, (this.agentExec.get(key) ?? 0) + 1);
    if (outcome === 'FAILED') {
      this.agentFail.set(agentType, (this.agentFail.get(agentType) ?? 0) + 1);
    }
    if (outcome === 'TIMEOUT') {
      this.agentTimeout.set(
        agentType,
        (this.agentTimeout.get(agentType) ?? 0) + 1,
      );
    }
    const current = this.agentDuration.get(agentType) ?? { count: 0, sum: 0 };
    current.count += 1;
    current.sum += Math.max(0, durationSeconds);
    this.agentDuration.set(agentType, current);
  }

  recordToolCall(durationSeconds: number): void {
    this.toolCalls += 1;
    this.toolDurationSum += Math.max(0, durationSeconds);
  }

  recordLlm(privacyMode: string, ok: boolean, durationSeconds: number): void {
    this.llmCalls.set(privacyMode, (this.llmCalls.get(privacyMode) ?? 0) + 1);
    this.llmDurationCount += 1;
    this.llmDurationSum += Math.max(0, durationSeconds);
    if (!ok) this.llmFail += 1;
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${AiopsMetricNames.INVESTIGATIONS_TOTAL} Investigaciones AIOps por resultado.`,
      `# TYPE ${AiopsMetricNames.INVESTIGATIONS_TOTAL} counter`,
    ];
    for (const [outcome, count] of this.investigations) {
      lines.push(
        `${AiopsMetricNames.INVESTIGATIONS_TOTAL}{outcome="${outcome}"} ${count}`,
      );
    }
    lines.push(
      `# HELP ${AiopsMetricNames.INVESTIGATION_FAILURES_TOTAL} Investigaciones fallidas o timeout.`,
      `# TYPE ${AiopsMetricNames.INVESTIGATION_FAILURES_TOTAL} counter`,
      `${AiopsMetricNames.INVESTIGATION_FAILURES_TOTAL} ${this.failures}`,
      `# HELP ${AiopsMetricNames.INVESTIGATION_DURATION_SECONDS} Duracion de la investigacion.`,
      `# TYPE ${AiopsMetricNames.INVESTIGATION_DURATION_SECONDS} histogram`,
    );
    DURATION_BUCKETS.forEach((bucket, index) => {
      lines.push(
        `${AiopsMetricNames.INVESTIGATION_DURATION_SECONDS}_bucket{le="${bucket}"} ${this.durationBuckets[index]}`,
      );
    });
    lines.push(
      `${AiopsMetricNames.INVESTIGATION_DURATION_SECONDS}_bucket{le="+Inf"} ${this.durationCount}`,
      `${AiopsMetricNames.INVESTIGATION_DURATION_SECONDS}_sum ${this.durationSum}`,
      `${AiopsMetricNames.INVESTIGATION_DURATION_SECONDS}_count ${this.durationCount}`,
      `# HELP ${AiopsMetricNames.INVESTIGATION_BUDGET_EXHAUSTED_TOTAL} Investigaciones que agotaron presupuesto.`,
      `# TYPE ${AiopsMetricNames.INVESTIGATION_BUDGET_EXHAUSTED_TOTAL} counter`,
      `${AiopsMetricNames.INVESTIGATION_BUDGET_EXHAUSTED_TOTAL} ${this.budgetExhausted}`,
      `# HELP ${AiopsMetricNames.AIOPS_AGENT_EXECUTIONS_TOTAL} Ejecuciones de AIOps Agents.`,
      `# TYPE ${AiopsMetricNames.AIOPS_AGENT_EXECUTIONS_TOTAL} counter`,
    );
    for (const [key, count] of this.agentExec) {
      const [agentType, outcome] = key.split(':');
      lines.push(
        `${AiopsMetricNames.AIOPS_AGENT_EXECUTIONS_TOTAL}{agent_type="${agentType}",outcome="${outcome}"} ${count}`,
      );
    }
    lines.push(
      `# HELP ${AiopsMetricNames.AIOPS_AGENT_FAILURES_TOTAL} Fallos de AIOps Agents.`,
      `# TYPE ${AiopsMetricNames.AIOPS_AGENT_FAILURES_TOTAL} counter`,
    );
    for (const [agentType, count] of this.agentFail) {
      lines.push(
        `${AiopsMetricNames.AIOPS_AGENT_FAILURES_TOTAL}{agent_type="${agentType}"} ${count}`,
      );
    }
    lines.push(
      `# HELP ${AiopsMetricNames.AIOPS_AGENT_TIMEOUTS_TOTAL} Timeouts de AIOps Agents.`,
      `# TYPE ${AiopsMetricNames.AIOPS_AGENT_TIMEOUTS_TOTAL} counter`,
    );
    for (const [agentType, count] of this.agentTimeout) {
      lines.push(
        `${AiopsMetricNames.AIOPS_AGENT_TIMEOUTS_TOTAL}{agent_type="${agentType}"} ${count}`,
      );
    }
    lines.push(
      `# HELP ${AiopsMetricNames.AIOPS_AGENT_DURATION_SECONDS} Duracion de AIOps Agents.`,
      `# TYPE ${AiopsMetricNames.AIOPS_AGENT_DURATION_SECONDS} counter`,
    );
    for (const [agentType, row] of this.agentDuration) {
      lines.push(
        `${AiopsMetricNames.AIOPS_AGENT_DURATION_SECONDS}_sum{agent_type="${agentType}"} ${row.sum}`,
        `${AiopsMetricNames.AIOPS_AGENT_DURATION_SECONDS}_count{agent_type="${agentType}"} ${row.count}`,
      );
    }
    lines.push(
      `# HELP ${AiopsMetricNames.TOOL_CALLS_TOTAL} Llamadas a tools de investigacion.`,
      `# TYPE ${AiopsMetricNames.TOOL_CALLS_TOTAL} counter`,
      `${AiopsMetricNames.TOOL_CALLS_TOTAL} ${this.toolCalls}`,
      `# HELP ${AiopsMetricNames.TOOL_CALL_DURATION_SECONDS} Duracion de tools.`,
      `# TYPE ${AiopsMetricNames.TOOL_CALL_DURATION_SECONDS} counter`,
      `${AiopsMetricNames.TOOL_CALL_DURATION_SECONDS}_sum ${this.toolDurationSum}`,
      `# HELP ${AiopsMetricNames.LLM_CALLS_TOTAL} Llamadas LLM de sintesis.`,
      `# TYPE ${AiopsMetricNames.LLM_CALLS_TOTAL} counter`,
    );
    for (const [privacy, count] of this.llmCalls) {
      lines.push(
        `${AiopsMetricNames.LLM_CALLS_TOTAL}{privacy_mode="${privacy}"} ${count}`,
      );
    }
    lines.push(
      `# HELP ${AiopsMetricNames.LLM_FAILURES_TOTAL} Fallos de LLM en sintesis.`,
      `# TYPE ${AiopsMetricNames.LLM_FAILURES_TOTAL} counter`,
      `${AiopsMetricNames.LLM_FAILURES_TOTAL} ${this.llmFail}`,
      `# HELP ${AiopsMetricNames.LLM_DURATION_SECONDS} Duracion de LLM.`,
      `# TYPE ${AiopsMetricNames.LLM_DURATION_SECONDS} counter`,
      `${AiopsMetricNames.LLM_DURATION_SECONDS}_sum ${this.llmDurationSum}`,
      `${AiopsMetricNames.LLM_DURATION_SECONDS}_count ${this.llmDurationCount}`,
    );
    return `${lines.join('\n')}\n`;
  }
}
