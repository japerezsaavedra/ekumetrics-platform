import { Injectable } from '@nestjs/common';
import type { AnomalyDetector, DetectionContext } from '../anomaly-detector';
import type { AnomalyAlgorithm, AnomalyResult, AnomalyWindow } from '../anomaly-result';

/**
 * Interfaz wave 2: change-point (PELT/CUSUM, etc.). Sin implementación ML.
 */
export interface ChangePointDetector extends AnomalyDetector {
  readonly algorithm: 'change_point';
}

/**
 * Interfaz wave 2: Isolation Forest. Sin implementación ML.
 */
export interface IsolationForestDetector extends AnomalyDetector {
  readonly algorithm: 'isolation_forest';
}

/**
 * Interfaz wave 2: baseline estacional. Sin implementación ML.
 */
export interface SeasonalBaselineDetector extends AnomalyDetector {
  readonly algorithm: 'seasonal_baseline';
}

abstract class AdvancedDetectorStub implements AnomalyDetector {
  abstract readonly algorithm: AnomalyAlgorithm;
  readonly windows: readonly AnomalyWindow[] = ['24h'];

  detect(_ctx: DetectionContext): AnomalyResult[] {
    return [];
  }
}

@Injectable()
export class ChangePointDetectorStub
  extends AdvancedDetectorStub
  implements ChangePointDetector
{
  readonly algorithm = 'change_point' as const;
}

@Injectable()
export class IsolationForestDetectorStub
  extends AdvancedDetectorStub
  implements IsolationForestDetector
{
  readonly algorithm = 'isolation_forest' as const;
}

@Injectable()
export class SeasonalBaselineDetectorStub
  extends AdvancedDetectorStub
  implements SeasonalBaselineDetector
{
  readonly algorithm = 'seasonal_baseline' as const;
}
