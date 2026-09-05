import { Injectable, Logger } from '@nestjs/common';
import { HistoricalService } from '../historical/historical.service';
import { NEUTRAL_HISTORICAL_SCORE } from './constants';
import {
  HISTORICAL_EVIDENCE_PORT,
  type HistoricalEvidence,
  type HistoricalEvidencePort,
  type HistoricalEvidenceQuery,
  neutralHistoricalEvidence,
} from './historical-evidence.port';

/**
 * Adapta HistoricalService al puerto RCA. Si el lookup falla, RCA sigue
 * con historicalScore neutro 0.5 (no hay evidencia, no se fabrica).
 */
@Injectable()
export class HistoricalServiceEvidenceAdapter implements HistoricalEvidencePort {
  private readonly logger = new Logger(HistoricalServiceEvidenceAdapter.name);

  constructor(private readonly historical: HistoricalService) {}

  async lookup(query: HistoricalEvidenceQuery): Promise<HistoricalEvidence> {
    if (!query.tenantId) return neutralHistoricalEvidence();
    try {
      const contribution = await this.historical.lookupForIncident(
        query.tenantId,
        query.incidentId,
      );
      if (contribution.tenantId !== query.tenantId) {
        return neutralHistoricalEvidence();
      }
      const supporting =
        contribution.stance === 'SUPPORTING' && contribution.matches.length > 0;
      if (!supporting) {
        return {
          available: false,
          score: NEUTRAL_HISTORICAL_SCORE,
          priorMatches: contribution.matches.length,
          summary: contribution.evidence[0]?.summary,
        };
      }
      return {
        available: true,
        score: contribution.historicalScore,
        priorMatches: contribution.matches.length,
        summary: contribution.evidence[0]?.summary,
      };
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'aiops.rca.historical_evidence.failed',
          tenantId: query.tenantId,
          incidentId: query.incidentId,
          error: error instanceof Error ? error.message : 'unknown',
        }),
      );
      return neutralHistoricalEvidence();
    }
  }
}

export { HISTORICAL_EVIDENCE_PORT };
