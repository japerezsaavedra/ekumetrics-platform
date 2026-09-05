import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../../observability/observability.module';
import { AnomalyEngine } from './anomaly.engine';
import { AnomalyMetrics } from './anomaly-metrics';
import { PrismaAnomalyPolicyRepository } from './prisma-anomaly-policy.repository';
import { PrismaAnomalyRepository } from './prisma-anomaly.repository';
import { ANOMALY_POLICY_REPOSITORY } from './anomaly-policy.repository';
import { ANOMALY_REPOSITORY } from './anomaly.repository';
import { ANOMALY_DETECTORS } from './anomaly.tokens';
import { AnomalyWorker } from './anomaly.worker';
import {
  ChangePointDetectorStub,
  IsolationForestDetectorStub,
  SeasonalBaselineDetectorStub,
} from './detectors/advanced-stubs';
import { EWMADetector } from './detectors/ewma.detector';
import { RobustZScoreDetector } from './detectors/robust-zscore.detector';
import { RollingBaselineDetector } from './detectors/rolling-baseline.detector';
import { StaticThresholdDetector } from './detectors/static-threshold.detector';
import { MetricWindowStore } from './metric-window.store';
import { PLATFORM_THRESHOLD_SOURCE } from './platform-threshold.source';
import { PrismaPlatformThresholdSource } from './platform-threshold.prisma';

@Module({
  imports: [ObservabilityModule],
  providers: [
    MetricWindowStore,
    AnomalyMetrics,
    StaticThresholdDetector,
    RollingBaselineDetector,
    RobustZScoreDetector,
    EWMADetector,
    ChangePointDetectorStub,
    IsolationForestDetectorStub,
    SeasonalBaselineDetectorStub,
    {
      provide: ANOMALY_DETECTORS,
      useFactory: (
        staticThreshold: StaticThresholdDetector,
        rolling: RollingBaselineDetector,
        robust: RobustZScoreDetector,
        ewma: EWMADetector,
      ) => [staticThreshold, rolling, robust, ewma],
      inject: [
        StaticThresholdDetector,
        RollingBaselineDetector,
        RobustZScoreDetector,
        EWMADetector,
      ],
    },
    PrismaAnomalyRepository,
    { provide: ANOMALY_REPOSITORY, useExisting: PrismaAnomalyRepository },
    PrismaAnomalyPolicyRepository,
    {
      provide: ANOMALY_POLICY_REPOSITORY,
      useExisting: PrismaAnomalyPolicyRepository,
    },
    PrismaPlatformThresholdSource,
    {
      provide: PLATFORM_THRESHOLD_SOURCE,
      useExisting: PrismaPlatformThresholdSource,
    },
    AnomalyEngine,
    AnomalyWorker,
  ],
  exports: [
    AnomalyEngine,
    AnomalyMetrics,
    ANOMALY_REPOSITORY,
    ANOMALY_POLICY_REPOSITORY,
    MetricWindowStore,
    ChangePointDetectorStub,
    IsolationForestDetectorStub,
    SeasonalBaselineDetectorStub,
  ],
})
export class AnomalyModule {}
