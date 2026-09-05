import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ANOMALY_REPOSITORY,
  type AnomalyRepository,
} from '../anomaly/anomaly.repository';
import type { AnomalyResult as EngineAnomaly } from '../anomaly/anomaly-result';
import {
  ANOMALY_EVIDENCE_PORT,
  type AnomalyEvidencePort,
  type AnomalyEvidenceQuery,
} from './anomaly-evidence.port';
import type { AnomalyResult } from './types';

@Injectable()
export class RepositoryAnomalyEvidenceAdapter implements AnomalyEvidencePort {
  private readonly logger = new Logger(RepositoryAnomalyEvidenceAdapter.name);

  constructor(
    @Inject(ANOMALY_REPOSITORY) private readonly anomalies: AnomalyRepository,
  ) {}

  async findForIncident(query: AnomalyEvidenceQuery): Promise<AnomalyResult[]> {
    if (!query.tenantId) return [];
    try {
      const rows = await this.anomalies.findForEntities(
        query.tenantId,
        query.entityKeys,
        { windowStart: query.windowStart, windowEnd: query.windowEnd },
      );
      return rows
        .filter((row) => row.tenantId === query.tenantId)
        .map(toRcaAnomaly);
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'aiops.rca.anomaly_evidence.failed',
          tenantId: query.tenantId,
          incidentId: query.incidentId,
          error: error instanceof Error ? error.message : 'unknown',
        }),
      );
      return [];
    }
  }
}

function toRcaAnomaly(row: EngineAnomaly): AnomalyResult {
  return {
    tenantId: row.tenantId,
    entityId: row.entityId,
    entityType: row.metadata.entityType,
    score: row.score,
    confidence: row.confidence,
    detector: row.algorithm,
    metric: row.metricName,
    summary: row.metadata.evidence[0]?.summary,
    startedAt: row.timestamp ? new Date(row.timestamp) : undefined,
  };
}

export { ANOMALY_EVIDENCE_PORT };
