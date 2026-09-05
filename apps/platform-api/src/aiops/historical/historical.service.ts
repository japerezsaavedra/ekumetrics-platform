import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MetricsService } from '../../observability/metrics.service';
import { assertTenantScope } from '../persistence/tenant-scope.error';
import type { HistoricalEvidencePort } from './historical-evidence.port';
import { neutralHistoricalContribution } from './historical-evidence.port';
import type {
  CreateFeedbackInput,
  HistoricalRepository,
} from './historical.repository';
import { HISTORICAL_REPOSITORY } from './historical.repository';
import { HistoricalMetrics } from './historical.metrics';
import { hashIncidentSignature } from './signature';
import { scoreSignatureSimilarity } from './similarity';
import type {
  HistoricalContribution,
  HistoricalMatch,
  IncidentSignature,
  IncidentSignatureInput,
  RcaFeedback,
  ResolutionRecord,
} from './types';
import {
  HISTORICAL_ALGORITHM,
  HISTORICAL_SOURCE,
  NEUTRAL_HISTORICAL_SCORE,
} from './types';

const MATCH_FLOOR = 0.15;
const SUPPORTING_FLOOR = 0.5;
const MAX_MATCHES = 10;

export type RecordFeedbackInput = CreateFeedbackInput & {
  signature?: IncidentSignatureInput;
  confirmedRootCause?: string;
  rejectedRootCause?: string;
  resolution?: string;
  successfulAction?: string;
  timeToDetectMs?: number;
  timeToResolveMs?: number;
};

/**
 * Matching histórico determinista. La evidencia es una señal (historicalScore),
 * nunca un veto sobre la evidencia actual del incidente.
 */
@Injectable()
export class HistoricalService implements HistoricalEvidencePort {
  private readonly logger = new Logger(HistoricalService.name);
  private readonly metrics = new HistoricalMetrics();

  constructor(
    @Inject(HISTORICAL_REPOSITORY)
    private readonly store: HistoricalRepository,
    @Optional() platformMetrics?: MetricsService,
  ) {
    platformMetrics?.registerContributor('aiops-historical', () =>
      this.metrics.render(),
    );
  }

  async recordSignature(
    tenantId: string,
    input: IncidentSignatureInput,
    incidentId?: string,
  ): Promise<IncidentSignature> {
    assertTenantScope(tenantId, input.tenantId);
    const { hash, characteristics } = hashIncidentSignature({
      ...input,
      tenantId,
    });
    return this.store.upsertSignature({
      tenantId,
      hash,
      incidentId: incidentId ?? input.incidentId,
      ...characteristics,
    });
  }

  async lookup(
    tenantId: string,
    signature: IncidentSignatureInput,
  ): Promise<HistoricalContribution> {
    assertTenantScope(tenantId, signature.tenantId);
    const { hash, characteristics } = hashIncidentSignature({
      ...signature,
      tenantId,
    });
    const [candidates, resolutions] = await Promise.all([
      this.store.listSignatures(tenantId),
      this.store.listResolutions(tenantId),
    ]);
    const resolutionByIncident = new Map(
      resolutions.map((row) => [row.incidentId, row]),
    );
    const resolutionBySignature = indexResolutionsBySignature(
      resolutions,
      candidates,
    );

    const excludeIncidentId = signature.incidentId;
    const matches: HistoricalMatch[] = [];
    for (const candidate of candidates) {
      if (candidate.tenantId !== tenantId) continue;
      const related =
        resolutionBySignature.get(candidate.id) ??
        fallbackIncidents(candidate, resolutionByIncident);
      const targets =
        related.length > 0
          ? related
          : [
              {
                incidentId: candidate.incidentIds[0] ?? '',
                resolution: undefined,
              },
            ];
      for (const target of targets) {
        if (!target.incidentId) continue;
        if (excludeIncidentId && target.incidentId === excludeIncidentId) {
          continue;
        }
        const scored = scoreSignatureSimilarity(characteristics, candidate, {
          queryRootCause: signature.proposedRootCause,
          resolution: target.resolution,
        });
        if (scored.similarity < MATCH_FLOOR && candidate.hash !== hash) {
          continue;
        }
        matches.push({
          incidentId: target.incidentId,
          signatureId: candidate.id,
          signatureHash: candidate.hash,
          similarity: scored.similarity,
          confidence: scored.confidence,
          evidence: [scored.evidence],
          algorithm: HISTORICAL_ALGORITHM,
          source: HISTORICAL_SOURCE,
          confirmedRootCause: target.resolution?.confirmedRootCause,
          rejectedRootCauses: target.resolution?.rejectedRootCauses ?? [],
          resolution: target.resolution?.resolution,
          successfulAction: target.resolution?.successfulAction,
        });
      }
    }

    matches.sort((a, b) => b.similarity - a.similarity);
    const top = dedupeByIncident(matches).slice(0, MAX_MATCHES);
    const contribution = toContribution(tenantId, top);
    this.metrics.recordLookup(contribution.stance === 'SUPPORTING');
    this.logger.log(
      `aiops historical lookup tenantId=${tenantId} matches=${top.length} stance=${contribution.stance} historicalScore=${contribution.historicalScore}`,
    );
    return contribution;
  }

  async recordFeedback(input: RecordFeedbackInput): Promise<RcaFeedback> {
    assertTenantScope(input.tenantId);
    let signatureId: string | undefined;
    if (input.signature) {
      const recorded = await this.recordSignature(
        input.tenantId,
        input.signature,
        input.incidentId,
      );
      signatureId = recorded.id;
    } else {
      const existing = await this.store.findSignatureByIncident(
        input.tenantId,
        input.incidentId,
      );
      signatureId = existing?.id;
    }

    await this.applyResolutionSideEffect(input, signatureId);
    const feedback = await this.store.createFeedback({
      tenantId: input.tenantId,
      incidentId: input.incidentId,
      action: input.action,
      selectedEntityId: input.selectedEntityId,
      note: input.note,
      userId: input.userId,
    });
    this.metrics.recordFeedback(input.action);
    this.logger.log(
      `aiops rca feedback tenantId=${input.tenantId} incidentId=${input.incidentId} action=${input.action}`,
    );
    return feedback;
  }

  listFeedback(tenantId: string, incidentId: string): Promise<RcaFeedback[]> {
    assertTenantScope(tenantId);
    return this.store.listFeedback(tenantId, incidentId);
  }

  findResolution(
    tenantId: string,
    incidentId: string,
  ): Promise<ResolutionRecord | null> {
    assertTenantScope(tenantId);
    return this.store.findResolutionByIncident(tenantId, incidentId);
  }

  async lookupForIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<HistoricalContribution> {
    assertTenantScope(tenantId);
    const stored = await this.store.findSignatureByIncident(
      tenantId,
      incidentId,
    );
    if (!stored) {
      this.metrics.recordLookup(false);
      return {
        ...neutralHistoricalContribution(tenantId),
        evidence: [
          {
            kind: 'historical',
            summary:
              'El incidente no tiene firma histórica persistida. Contribución NEUTRAL.',
            score: NEUTRAL_HISTORICAL_SCORE,
            confidence: 0,
            algorithm: HISTORICAL_ALGORITHM,
            source: HISTORICAL_SOURCE,
            facts: {
              dimensions: [],
              candidateIncidentId: '',
              signatureHash: '',
            },
          },
        ],
      };
    }
    return this.lookup(tenantId, {
      tenantId,
      incidentId,
      entityTypes: stored.entityTypes,
      serviceKey: stored.serviceKey,
      eventTypes: stored.eventTypes,
      anomalyTypes: stored.anomalyTypes,
      topologyPattern: stored.topologyPattern,
      environment: stored.environment,
    });
  }

  private async applyResolutionSideEffect(
    input: RecordFeedbackInput,
    signatureId: string | undefined,
  ): Promise<void> {
    const cause = input.confirmedRootCause ?? input.selectedEntityId;
    if (input.action === 'CONFIRM') {
      await this.store.upsertResolution({
        tenantId: input.tenantId,
        incidentId: input.incidentId,
        signatureId,
        confirmedRootCause: cause,
        resolution: input.resolution ?? input.note,
        successfulAction: input.successfulAction,
        timeToDetectMs: input.timeToDetectMs,
        timeToResolveMs: input.timeToResolveMs,
      });
      return;
    }
    if (input.action === 'REJECT') {
      const rejected = input.rejectedRootCause ?? input.selectedEntityId;
      await this.store.upsertResolution({
        tenantId: input.tenantId,
        incidentId: input.incidentId,
        signatureId,
        appendRejected: rejected ? [rejected] : undefined,
        resolution: input.resolution ?? input.note,
        timeToDetectMs: input.timeToDetectMs,
        timeToResolveMs: input.timeToResolveMs,
      });
      return;
    }
    if (input.action === 'SELECT_ALTERNATIVE') {
      const current = await this.store.findResolutionByIncident(
        input.tenantId,
        input.incidentId,
      );
      const previous = current?.confirmedRootCause;
      await this.store.upsertResolution({
        tenantId: input.tenantId,
        incidentId: input.incidentId,
        signatureId,
        confirmedRootCause: cause,
        appendRejected: previous && previous !== cause ? [previous] : undefined,
        resolution: input.resolution ?? input.note,
        successfulAction: input.successfulAction,
        timeToDetectMs: input.timeToDetectMs,
        timeToResolveMs: input.timeToResolveMs,
      });
      return;
    }
    if (input.note || input.resolution) {
      await this.store.upsertResolution({
        tenantId: input.tenantId,
        incidentId: input.incidentId,
        signatureId,
        resolution: input.resolution ?? input.note,
        timeToDetectMs: input.timeToDetectMs,
        timeToResolveMs: input.timeToResolveMs,
      });
    }
  }
}

function toContribution(
  tenantId: string,
  matches: HistoricalMatch[],
): HistoricalContribution {
  if (matches.length === 0) {
    return neutralHistoricalContribution(tenantId);
  }
  const best = matches[0];
  const supporting = best.similarity > SUPPORTING_FLOOR;
  const historicalScore = supporting
    ? best.similarity
    : NEUTRAL_HISTORICAL_SCORE;
  return {
    tenantId,
    historicalScore,
    confidence: supporting ? best.confidence : 0,
    matches,
    stance: supporting ? 'SUPPORTING' : 'NEUTRAL',
    overridesCurrentEvidence: false,
    algorithm: HISTORICAL_ALGORITHM,
    source: HISTORICAL_SOURCE,
    evidence: supporting
      ? best.evidence
      : [
          {
            kind: 'historical',
            summary:
              'Hay candidatos débiles; historicalScore permanece NEUTRAL y no sustituye la evidencia actual.',
            score: NEUTRAL_HISTORICAL_SCORE,
            confidence: 0,
            algorithm: HISTORICAL_ALGORITHM,
            source: HISTORICAL_SOURCE,
            facts: {
              dimensions: [],
              candidateIncidentId: best.incidentId,
              signatureHash: best.signatureHash,
            },
          },
        ],
  };
}

function indexResolutionsBySignature(
  resolutions: ResolutionRecord[],
  signatures: IncidentSignature[],
): Map<string, Array<{ incidentId: string; resolution: ResolutionRecord }>> {
  const byId = new Map(signatures.map((row) => [row.id, row]));
  const index = new Map<
    string,
    Array<{ incidentId: string; resolution: ResolutionRecord }>
  >();
  for (const resolution of resolutions) {
    const signatureId =
      resolution.signatureId ??
      signatures.find((row) => row.incidentIds.includes(resolution.incidentId))
        ?.id;
    if (!signatureId || !byId.has(signatureId)) continue;
    const list = index.get(signatureId) ?? [];
    list.push({ incidentId: resolution.incidentId, resolution });
    index.set(signatureId, list);
  }
  return index;
}

function fallbackIncidents(
  candidate: IncidentSignature,
  resolutionByIncident: Map<string, ResolutionRecord>,
): Array<{ incidentId: string; resolution?: ResolutionRecord }> {
  return candidate.incidentIds.map((incidentId) => ({
    incidentId,
    resolution: resolutionByIncident.get(incidentId),
  }));
}

function dedupeByIncident(matches: HistoricalMatch[]): HistoricalMatch[] {
  const best = new Map<string, HistoricalMatch>();
  for (const match of matches) {
    const current = best.get(match.incidentId);
    if (!current || match.similarity > current.similarity) {
      best.set(match.incidentId, match);
    }
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity);
}
