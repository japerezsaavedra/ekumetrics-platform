import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../../observability/observability.module';
import { AnomalyModule } from '../anomaly/anomaly.module';
import { HistoricalModule } from '../historical/historical.module';
import { RCA_ENGINE } from '../interfaces/rca-engine';
import { IncidentsModule } from '../incidents.module';
import { ANOMALY_EVIDENCE_PORT } from './anomaly-evidence.port';
import { DeterministicRcaEngine } from './engine';
import { HISTORICAL_EVIDENCE_PORT } from './historical-evidence.port';
import { HistoricalServiceEvidenceAdapter } from './historical-service-evidence.adapter';
import {
  PrismaRcaIncidentSource,
  RCA_INCIDENT_SOURCE,
} from './incident-source';
import { RcaMetrics } from './metrics';
import { RepositoryAnomalyEvidenceAdapter } from './repository-anomaly-evidence.adapter';
import {
  RCA_SCORING_POLICY,
  RcaScoringPolicyLoader,
} from './scoring-policy';
import { RcaEventSubscriber } from './subscriber';

/**
 * RCA Wave 2.5: RcaEngine determinista cableado a anomalías e histórico reales.
 * Sin AgentOrchestrator ni LLM.
 */
@Module({
  imports: [
    IncidentsModule,
    ObservabilityModule,
    AnomalyModule,
    HistoricalModule,
  ],
  providers: [
    RcaMetrics,
    PrismaRcaIncidentSource,
    HistoricalServiceEvidenceAdapter,
    RepositoryAnomalyEvidenceAdapter,
    RcaScoringPolicyLoader,
    DeterministicRcaEngine,
    RcaEventSubscriber,
    { provide: RCA_INCIDENT_SOURCE, useExisting: PrismaRcaIncidentSource },
    {
      provide: HISTORICAL_EVIDENCE_PORT,
      useExisting: HistoricalServiceEvidenceAdapter,
    },
    {
      provide: ANOMALY_EVIDENCE_PORT,
      useExisting: RepositoryAnomalyEvidenceAdapter,
    },
    { provide: RCA_SCORING_POLICY, useExisting: RcaScoringPolicyLoader },
    { provide: RCA_ENGINE, useExisting: DeterministicRcaEngine },
  ],
  exports: [
    RCA_ENGINE,
    DeterministicRcaEngine,
    RcaMetrics,
    HISTORICAL_EVIDENCE_PORT,
    ANOMALY_EVIDENCE_PORT,
    RCA_SCORING_POLICY,
    RCA_INCIDENT_SOURCE,
  ],
})
export class RcaModule {}
