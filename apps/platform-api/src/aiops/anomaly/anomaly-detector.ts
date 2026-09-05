import type {
  AnomalyAlgorithm,
  AnomalyResult,
  AnomalyWindow,
} from './anomaly-result';
import type { MetricPoint } from './metric-sample';
import type { ResolvedAnomalyPolicy } from './anomaly-policy';
import type { PlatformThresholds } from '../../platform/platform-thresholds';

export type DetectionContext = {
  tenantId: string;
  entityId: string;
  metricName: string;
  points: MetricPoint[];
  now: number;
  window: AnomalyWindow;
  policy: ResolvedAnomalyPolicy;
  thresholds: PlatformThresholds;
  siteId?: string;
  entityType?: string;
  environment?: string;
};

/**
 * Detector numérico explicable. Sin LLM.
 * Implementaciones avanzadas (change-point, isolation forest, seasonal)
 * pueden existir solo como interfaz/stub.
 */
export interface AnomalyDetector {
  readonly algorithm: AnomalyAlgorithm;
  readonly windows: readonly AnomalyWindow[];
  detect(ctx: DetectionContext): AnomalyResult[];
}
