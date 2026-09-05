import { EventBusValidationError } from '../../messaging/errors';
import {
  AiopsMetricNames,
  DEFAULT_RCA_SCORING_WEIGHTS,
  DETECTOR_TYPE_TO_ALGORITHM,
  EventSubjects,
  Wave2EventSubjects,
  assertAiopsBusPayload,
  createExplainableOutput,
  createScoredRootCauseCandidate,
  defaultRcaScoringPolicy,
  fromPrismaRcaWeights,
  normalizeRcaScoringWeights,
  parseRcaFeedbackAction,
  rcaScoringWeightsTotal,
  toPrismaRcaWeights,
} from './index';
import { createRcaEvidence } from '../types/rca-evidence';

describe('contratos AIOps Wave 2', () => {
  it('exige tenantId en payloads del EventBus', () => {
    expect(() => assertAiopsBusPayload({ incidentId: 'inc-1' })).toThrow(
      EventBusValidationError,
    );
    expect(() =>
      assertAiopsBusPayload({ tenantId: 'tenant-a', incidentId: 'inc-1' }),
    ).not.toThrow();
  });

  it('reutiliza subjects RCA Wave 1 y añade anomalías / enrichment', () => {
    expect(Wave2EventSubjects.RCA_REQUESTED).toBe('ekumetrics.rca.requested');
    expect(Wave2EventSubjects.RCA_COMPLETED).toBe('ekumetrics.rca.completed');
    expect(Wave2EventSubjects.EVENTS_INGESTED).toBe(
      EventSubjects.EVENTS_INGESTED,
    );
    expect(Wave2EventSubjects.ANOMALIES_DETECTED).toBe(
      EventSubjects.ANOMALIES_DETECTED,
    );
    expect(Wave2EventSubjects.INCIDENTS_ENRICHMENT_REQUESTED).toBe(
      'ekumetrics.incidents.enrichment.requested',
    );
    expect(Wave2EventSubjects.INCIDENTS_ENRICHED).toBe(
      'ekumetrics.incidents.enriched',
    );
  });

  it('mantiene pesos RCA por defecto que suman 1.0', () => {
    expect(rcaScoringWeightsTotal(DEFAULT_RCA_SCORING_WEIGHTS)).toBeCloseTo(
      1,
      10,
    );
    const normalized = normalizeRcaScoringWeights({
      temporal: 2,
      topology: 2,
      anomaly: 2,
      dependency: 2,
      historical: 2,
    });
    expect(rcaScoringWeightsTotal(normalized)).toBeCloseTo(1, 10);
    expect(fromPrismaRcaWeights(toPrismaRcaWeights(DEFAULT_RCA_SCORING_WEIGHTS))).toEqual(
      DEFAULT_RCA_SCORING_WEIGHTS,
    );
    expect(defaultRcaScoringPolicy('tenant-a').tenantId).toBe('tenant-a');
  });

  it('mapea detectorType PascalCase a algorithm persistido', () => {
    expect(DETECTOR_TYPE_TO_ALGORITHM.StaticThreshold).toBe('static_threshold');
    expect(DETECTOR_TYPE_TO_ALGORITHM.RobustZScore).toBe('robust_zscore');
  });

  it('expone nombres de métricas OTEL Wave 2', () => {
    expect(AiopsMetricNames.ANOMALIES_DETECTED_TOTAL).toBe(
      'aiops_anomalies_detected_total',
    );
    expect(AiopsMetricNames.RCA_DURATION_SECONDS).toBe(
      'aiops_rca_duration_seconds',
    );
    expect(AiopsMetricNames.ROOT_CAUSE_SUPPRESSIONS_TOTAL).toBe(
      'aiops_root_cause_suppressions_total',
    );
    expect(AiopsMetricNames.EVENTS_INGESTED_PUBLISHED_TOTAL).toBe(
      'aiops_events_ingested_published_total',
    );
    expect(AiopsMetricNames.ANOMALY_PERSISTENCE_TOTAL).toBe(
      'aiops_anomaly_persistence_total',
    );
    expect(AiopsMetricNames.RCA_REQUESTED_PUBLISHED_TOTAL).toBe(
      'aiops_rca_requested_published_total',
    );
    expect(AiopsMetricNames.ENRICHMENT_UPDATES_TOTAL).toBe(
      'aiops_enrichment_updates_total',
    );
    expect(AiopsMetricNames.FEEDBACK_TOTAL).toBe('aiops_feedback_total');
  });

  it('normaliza feedback RCA lowercase al enum canónico', () => {
    expect(parseRcaFeedbackAction('confirm')).toBe('CONFIRM');
    expect(parseRcaFeedbackAction('SELECT_ALTERNATIVE')).toBe(
      'SELECT_ALTERNATIVE',
    );
    expect(parseRcaFeedbackAction('hack')).toBeNull();
  });

  it('crea candidato RCA con subscores y entityId', () => {
    const evidence = [
      createRcaEvidence({
        kind: 'topology',
        summary: 'dependencia saturada',
        facts: { hops: 2 },
      }),
    ];
    const scored = createScoredRootCauseCandidate({
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
      rank: 1,
      entityId: 'sw-core',
      entityType: 'device',
      hypothesis: 'Switch core saturado',
      confidence: 0.8,
      score: 0.76,
      evidence,
      source: 'deterministic_rca',
      findingIds: [],
      affectedEntities: ['sw-core', 'api-pagos'],
      affectedServices: ['checkout'],
      firstObservedAt: new Date('2026-09-05T10:00:00Z'),
      subscores: {
        temporalScore: 0.7,
        topologyScore: 0.8,
        anomalyScore: 0.9,
        dependencyScore: 0.6,
        historicalScore: 0.5,
      },
    });
    expect(scored.entityId).toBe('sw-core');
    expect(scored.entityKey).toBe('sw-core');
    expect(scored.subscores.topologyScore).toBe(0.8);
  });

  it('exige evidencia en ExplainableOutput', () => {
    const evidence = [
      createRcaEvidence({
        kind: 'metric',
        summary: 'z-score 4.1',
        facts: { z: 4.1 },
      }),
    ];
    expect(
      createExplainableOutput({
        score: 0.9,
        confidence: 0.7,
        evidence,
        algorithm: 'robust_zscore',
        source: 'AiopsAnomaly',
      }).algorithm,
    ).toBe('robust_zscore');
    expect(() =>
      createExplainableOutput({
        score: 0.9,
        confidence: 0.7,
        evidence: [],
        algorithm: 'robust_zscore',
      }),
    ).toThrow(/evidencia/);
  });
});
