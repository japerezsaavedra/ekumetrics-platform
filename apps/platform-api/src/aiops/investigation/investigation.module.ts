import { Module } from '@nestjs/common';
import { DashboardModule } from '../../dashboard/dashboard.module';
import { ObservabilityModule } from '../../observability/observability.module';
import { AiopsDomainModule } from '../aiops-domain.module';
import { IncidentsModule } from '../incidents.module';
import { RcaModule } from '../rca/rca.module';
import { AGENT_ORCHESTRATOR } from '../interfaces/agent-orchestrator';
import { AgentSelectionService } from './agent-selection.service';
import {
  AIOPS_AGENTS,
  AgentOrchestratorService,
} from './agent-orchestrator';
import { InvestigationContextBuilder } from './investigation-context.builder';
import { InvestigationController } from './investigation.controller';
import { InvestigationMetrics } from './investigation.metrics';
import {
  InvestigationPolicyService,
  PrismaInvestigationPolicyRepository,
} from './investigation-policy.service';
import { InvestigationRequestedSubscriber } from './investigation.requested.subscriber';
import { AiCompletionPort } from './ai/ai-completion.port';
import { RcaAgent } from './agents/rca.agent';
import { MetricsAgent } from './agents/metrics.agent';
import { LogsAgent } from './agents/logs.agent';
import { KubernetesAgent } from './agents/kubernetes.agent';
import { TopologyAgent } from './agents/topology.agent';
import { SynthesisAgent } from './agents/synthesis.agent';
import { InvestigationTelemetryPort } from './telemetry/investigation-telemetry.port';
import {
  HolmesKubernetesAdapter,
  KubernetesToolProvider,
} from './tools/kubernetes-tool.provider';

@Module({
  imports: [
    AiopsDomainModule,
    IncidentsModule,
    RcaModule,
    DashboardModule,
    ObservabilityModule,
  ],
  controllers: [InvestigationController],
  providers: [
    PrismaInvestigationPolicyRepository,
    InvestigationPolicyService,
    InvestigationContextBuilder,
    AgentSelectionService,
    InvestigationMetrics,
    InvestigationTelemetryPort,
    AiCompletionPort,
    HolmesKubernetesAdapter,
    KubernetesToolProvider,
    RcaAgent,
    MetricsAgent,
    LogsAgent,
    KubernetesAgent,
    TopologyAgent,
    SynthesisAgent,
    {
      provide: AIOPS_AGENTS,
      useFactory: (
        rca: RcaAgent,
        metrics: MetricsAgent,
        logs: LogsAgent,
        kubernetes: KubernetesAgent,
        topology: TopologyAgent,
      ) => [rca, metrics, logs, kubernetes, topology],
      inject: [
        RcaAgent,
        MetricsAgent,
        LogsAgent,
        KubernetesAgent,
        TopologyAgent,
      ],
    },
    AgentOrchestratorService,
    { provide: AGENT_ORCHESTRATOR, useExisting: AgentOrchestratorService },
    InvestigationRequestedSubscriber,
  ],
  exports: [
    AGENT_ORCHESTRATOR,
    AgentOrchestratorService,
    InvestigationPolicyService,
  ],
})
export class InvestigationModule {}
