import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventBusUnavailableError } from '../../messaging/errors';
import {
  EVENT_BUS,
  EventSubjects,
  buildHeaders,
  type EventBus,
} from '../../messaging';
import { MetricsService } from '../../observability/metrics.service';
import type { AnomalyDetector } from './anomaly-detector';
import { ANOMALY_DETECTORS } from './anomaly.tokens';
import { AnomalyMetrics } from './anomaly-metrics';
import type { AnomalyPolicyRepository } from './anomaly-policy.repository';
import { ANOMALY_POLICY_REPOSITORY } from './anomaly-policy.repository';
import type { AnomalyRepository } from './anomaly.repository';
import { ANOMALY_REPOSITORY } from './anomaly.repository';
import type {
  AnomaliesDetectedPayload,
  AnomalyAlgorithm,
  AnomalyResult,
} from './anomaly-result';
import type { MetricSample } from './metric-sample';
import { MetricWindowStore } from './metric-window.store';
import type { PlatformThresholdSource } from './platform-threshold.source';
import { PLATFORM_THRESHOLD_SOURCE } from './platform-threshold.source';

/**
 * Orquesta detectores numéricos (sin LLM), aplica política por tenant
 * y publica `ekumetrics.anomalies.detected` de forma asíncrona.
 */
@Injectable()
export class AnomalyEngine {
  private readonly logger = new Logger(AnomalyEngine.name);

  constructor(
    @Inject(ANOMALY_DETECTORS) private readonly detectors: AnomalyDetector[],
    @Inject(ANOMALY_POLICY_REPOSITORY)
    private readonly policies: AnomalyPolicyRepository,
    @Inject(PLATFORM_THRESHOLD_SOURCE)
    private readonly thresholds: PlatformThresholdSource,
    @Inject(ANOMALY_REPOSITORY) private readonly repository: AnomalyRepository,
    private readonly windows: MetricWindowStore,
    private readonly metrics: AnomalyMetrics,
    @Optional() @Inject(EVENT_BUS) private readonly eventBus?: EventBus,
    @Optional() platformMetrics?: MetricsService,
  ) {
    platformMetrics?.registerContributor('aiops-anomaly', () =>
      this.metrics.render(),
    );
  }

  async ingestAndDetect(
    samples: MetricSample[],
    now = Date.now(),
  ): Promise<AnomalyResult[]> {
    const byTenant = new Map<string, MetricSample[]>();
    for (const sample of samples) {
      if (!sample.tenantId) continue;
      const list = byTenant.get(sample.tenantId) ?? [];
      list.push(sample);
      byTenant.set(sample.tenantId, list);
    }
    const results: AnomalyResult[] = [];
    for (const [tenantId, tenantSamples] of byTenant) {
      results.push(...(await this.detectTenant(tenantId, tenantSamples, now)));
    }
    return results;
  }

  async detectTenant(
    tenantId: string,
    samples: MetricSample[],
    now = Date.now(),
  ): Promise<AnomalyResult[]> {
    if (!tenantId) return [];
    const started = process.hrtime.bigint();
    const scoped = samples.filter((sample) => sample.tenantId === tenantId);
    for (const sample of scoped) {
      this.windows.append(sample);
    }
    const dirty = this.windows.takeDirty(tenantId);
    const results: AnomalyResult[] = [];
    for (const series of dirty) {
      if (series.tenantId !== tenantId) continue;
      results.push(...(await this.evaluateSeries(series, now)));
    }
    const duration =
      Number(process.hrtime.bigint() - started) / 1_000_000_000;
    this.metrics.record(duration, countByAlgorithm(results));
    return results;
  }

  async evaluateSeries(
    series: {
      tenantId: string;
      entityId: string;
      metricName: string;
      siteId?: string;
      entityType?: string;
      environment?: string;
    },
    now = Date.now(),
  ): Promise<AnomalyResult[]> {
    const { tenantId } = series;
    if (!tenantId) return [];
    const ctxMeta = this.windows.context(
      tenantId,
      series.entityId,
      series.metricName,
    );
    const siteId = series.siteId ?? ctxMeta?.siteId;
    const entityType = series.entityType ?? ctxMeta?.entityType;
    const environment = series.environment ?? ctxMeta?.environment;
    const policy = await this.policies.resolve(tenantId, {
      siteId,
      entityType,
      entityId: series.entityId,
      metricName: series.metricName,
      environment,
    });
    const thresholds = await this.thresholds.getForTenant(tenantId);
    const found: AnomalyResult[] = [];

    for (const detector of this.detectors) {
      if (!policy.enabledDetectors.includes(detector.algorithm)) continue;
      let best: AnomalyResult | undefined;
      for (const window of detector.windows) {
        const points = this.windows.getWindow(
          tenantId,
          series.entityId,
          series.metricName,
          window,
          now,
        );
        const minSamples =
          detector.algorithm === 'static_threshold' ? 1 : policy.minSamples;
        if (points.length < minSamples) continue;
        const hits = detector.detect({
          tenantId,
          entityId: series.entityId,
          metricName: series.metricName,
          points,
          now,
          window,
          policy,
          thresholds,
          siteId,
          entityType,
          environment,
        });
        for (const hit of hits) {
          if (hit.tenantId !== tenantId) continue;
          if (hit.score < policy.minScore) continue;
          if (!best || hit.score > best.score) best = hit;
        }
      }
      if (best) found.push(best);
    }

    if (!found.length) return [];
    await this.repository.saveMany(tenantId, found);
    this.metrics.recordPersisted(found.length);
    await this.publish(tenantId, series.entityId, series.metricName, found);
    this.logger.log(
      JSON.stringify({
        event: 'aiops.anomaly.detected',
        tenantId,
        entityId: series.entityId,
        metricName: series.metricName,
        count: found.length,
        algorithms: found.map((item) => item.algorithm),
      }),
    );
    return found;
  }

  private async publish(
    tenantId: string,
    entityId: string,
    metricName: string,
    anomalies: AnomalyResult[],
  ): Promise<void> {
    if (!this.eventBus) return;
    const detectedAt = new Date().toISOString();
    const payload: AnomaliesDetectedPayload = {
      tenantId,
      entityId,
      metricName,
      detectedAt,
      anomalies,
    };
    try {
      await this.eventBus.publish(EventSubjects.ANOMALIES_DETECTED, {
        payload,
        headers: buildHeaders({
          tenantId,
          correlationId: `${tenantId}:anomaly:${entityId}:${metricName}:${detectedAt}`,
          producedBy: 'anomaly-engine',
          siteId: anomalies[0]?.metadata.siteId,
        }),
        idempotencyKey: `${tenantId}:anomalies.detected:${anomalies[0]?.id ?? entityId}`,
      });
    } catch (error) {
      if (error instanceof EventBusUnavailableError) {
        this.logger.warn(
          JSON.stringify({
            event: 'aiops.anomaly.publish.skipped',
            reason: 'event_bus_unavailable',
            tenantId,
          }),
        );
        return;
      }
      this.logger.error(
        JSON.stringify({
          event: 'aiops.anomaly.publish.failed',
          tenantId,
          error: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
  }
}

function countByAlgorithm(results: AnomalyResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    const key: AnomalyAlgorithm = result.algorithm;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
