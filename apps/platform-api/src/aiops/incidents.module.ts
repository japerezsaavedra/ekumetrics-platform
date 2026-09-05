import { Module } from '@nestjs/common';
import { AlertmanagerModule } from '../alertmanager/alertmanager.module';
import { ObservabilityModule } from '../observability/observability.module';
import { AnomalyModule } from './anomaly/anomaly.module';
import { CorrelationMetrics } from './correlation-metrics';
import { CorrelationService } from './correlation.service';
import {
  CORRELATION_PIPELINE_CONSUMER,
  DeferredCorrelationPipelineConsumer,
} from './correlation-pipeline.port';
import { CorrelationPipelineSubscriber } from './correlation-pipeline.subscriber';
import { GraphService } from './graph.service';
import { HistoricalModule } from './historical/historical.module';
import { IncidentsController } from './incidents.controller';
import { PostgresTopologyRepository } from './topology.postgres.repository';
import { TOPOLOGY_REPOSITORY } from './topology.repository';
import { TopologyCorrelationMetrics } from './topology-correlation/topology-correlation.metrics';
import { TopologyCorrelationService } from './topology-correlation/topology-correlation.service';
import { IncidentEnrichmentMetrics } from './enrichment/incident-enrichment.metrics';
import { IncidentEnrichmentPublisher } from './enrichment/incident-enrichment.publisher';
import {
  INCIDENT_ENRICHMENT_REPOSITORY,
  InMemoryIncidentEnrichmentRepository,
} from './enrichment/incident-enrichment.repository';
import { PrismaIncidentEnrichmentRepository } from './enrichment/prisma-incident-enrichment.repository';
import { IncidentEnrichmentService } from './enrichment/incident-enrichment.service';
import { IncidentEnrichmentWorker } from './enrichment/incident-enrichment.worker';
import { IncidentPriorityCalculator } from './enrichment/incident-priority.calculator';
import { IncidentRcaCompletedSubscriber } from './enrichment/incident-rca-completed.subscriber';

@Module({
  imports: [
    AlertmanagerModule,
    ObservabilityModule,
    AnomalyModule,
    HistoricalModule,
  ],
  controllers: [IncidentsController],
  providers: [
    GraphService,
    CorrelationService,
    CorrelationMetrics,
    PostgresTopologyRepository,
    {
      provide: TOPOLOGY_REPOSITORY,
      useExisting: PostgresTopologyRepository,
    },
    TopologyCorrelationMetrics,
    TopologyCorrelationService,
    IncidentEnrichmentMetrics,
    {
      provide: IncidentPriorityCalculator,
      useFactory: () => new IncidentPriorityCalculator(),
    },
    InMemoryIncidentEnrichmentRepository,
    PrismaIncidentEnrichmentRepository,
    {
      provide: INCIDENT_ENRICHMENT_REPOSITORY,
      useExisting: PrismaIncidentEnrichmentRepository,
    },
    IncidentEnrichmentService,
    IncidentEnrichmentPublisher,
    IncidentEnrichmentWorker,
    IncidentRcaCompletedSubscriber,
    DeferredCorrelationPipelineConsumer,
    {
      provide: CORRELATION_PIPELINE_CONSUMER,
      useExisting: DeferredCorrelationPipelineConsumer,
    },
    CorrelationPipelineSubscriber,
  ],
  exports: [
    GraphService,
    CorrelationService,
    CorrelationMetrics,
    TOPOLOGY_REPOSITORY,
    PostgresTopologyRepository,
    TopologyCorrelationService,
    TopologyCorrelationMetrics,
    IncidentEnrichmentService,
    IncidentEnrichmentPublisher,
    INCIDENT_ENRICHMENT_REPOSITORY,
  ],
})
export class IncidentsModule {}
