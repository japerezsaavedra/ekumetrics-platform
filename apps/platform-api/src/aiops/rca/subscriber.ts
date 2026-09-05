import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  EVENT_BUS,
  EventSubjects,
  buildHeaders,
  type EventBus,
  type Subscription,
} from '../../messaging';
import { RCA_ENGINE, type RcaEngine } from '../interfaces/rca-engine';
import {
  RCA_ALGORITHM,
  RCA_CONSUMER_NAME,
  RCA_PRODUCED_BY,
} from './constants';
import type {
  RcaCompletedCandidate,
  RcaCompletedPayload,
  RcaRequestedPayload,
} from './types';

/**
 * RCA asíncrono: consume ekumetrics.rca.requested y publica
 * ekumetrics.rca.completed. No bloquea ingest HTTP.
 */
@Injectable()
export class RcaEventSubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RcaEventSubscriber.name);
  private subscription?: Subscription;

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    @Inject(RCA_ENGINE) private readonly rcaEngine: RcaEngine,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus.isAvailable()) {
      this.logger.log(
        `aiops RcaEngine subscriber skipped event_bus_unavailable`,
      );
      return;
    }
    this.subscription = await this.eventBus.subscribe<RcaRequestedPayload>(
      {
        subject: EventSubjects.RCA_REQUESTED,
        consumerName: RCA_CONSUMER_NAME,
        queueGroup: RCA_CONSUMER_NAME,
      },
      async (msg, ctrl) => {
        const tenantId = msg.headers.tenantId;
        const payload = msg.payload;
        if (!tenantId || !payload?.tenantId) {
          this.logger.log(
            `aiops RcaEngine requested missing tenantId incidentId=${payload?.incidentId ?? ''}`,
          );
          await ctrl.term('tenantId is required');
          return;
        }
        if (payload.tenantId !== tenantId) {
          await ctrl.term('tenantId header/payload mismatch');
          return;
        }
        const started = Date.now();
        try {
          const candidates = await this.rcaEngine.propose({
            tenantId,
            incidentId: payload.incidentId,
            investigationId: payload.investigationId,
            entityKeys: payload.entityKeys,
            preliminaryCauseKey: payload.preliminaryCauseKey,
          });
          const durationMs = Date.now() - started;
          const leading = candidates[0];
          const completed: RcaCompletedPayload = {
            tenantId,
            incidentId: payload.incidentId,
            investigationId: payload.investigationId,
            algorithm: RCA_ALGORITHM,
            durationMs,
            leadingScore: leading?.score,
            leadingConfidence: leading?.confidence,
            candidateCount: candidates.length,
            primaryEntityId: leading?.entityId ?? leading?.entityKey,
            rcaConfidence: leading?.confidence,
            candidates: candidates.map(toCompletedCandidate),
          };
          await this.eventBus.publish(EventSubjects.RCA_COMPLETED, {
            payload: completed,
            headers: buildHeaders({
              tenantId,
              incidentId: payload.incidentId,
              correlationId: msg.headers.correlationId,
              causationId: msg.idempotencyKey,
              producedBy: RCA_PRODUCED_BY,
              siteId: msg.headers.siteId,
            }),
            idempotencyKey: `${tenantId}:rca.completed:${payload.incidentId}:${msg.headers.correlationId}`,
          });
          this.logger.log(
            `aiops RcaEngine rca.completed tenantId=${tenantId} incidentId=${payload.incidentId} candidates=${candidates.length} duration_ms=${durationMs}`,
          );
          await ctrl.ack();
        } catch (error) {
          this.logger.log(
            `aiops RcaEngine rca.requested failed tenantId=${tenantId} incidentId=${payload.incidentId} error=${error instanceof Error ? error.message : 'unknown'}`,
          );
          await ctrl.nak();
        }
      },
    );
    this.logger.log(
      `aiops RcaEngine subscribed subject=${EventSubjects.RCA_REQUESTED} consumer=${RCA_CONSUMER_NAME} driver=${this.eventBus.driver}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscription?.unsubscribe();
  }
}

function toCompletedCandidate(
  candidate: {
    entityId?: string;
    entityKey?: string;
    entityType?: string;
    rank: number;
    score?: number;
    confidence: number;
    hypothesis: string;
    algorithm?: string;
    source: string;
    evidence: Array<{
      kind: string;
      summary: string;
      confidence?: number;
      entityKey?: string;
      facts: Record<string, unknown>;
    }>;
    affectedEntities?: string[];
    affectedServices?: string[];
    firstObservedAt?: Date;
    subscores?: RcaCompletedCandidate['subscores'];
    weights?: RcaCompletedCandidate['weights'];
  },
  _index: number,
): RcaCompletedCandidate {
  return {
    entityId: candidate.entityId ?? candidate.entityKey ?? '',
    entityType: candidate.entityType,
    entityKey: candidate.entityKey ?? candidate.entityId,
    rank: candidate.rank,
    score: candidate.score ?? candidate.confidence,
    confidence: candidate.confidence,
    hypothesis: candidate.hypothesis,
    algorithm: candidate.algorithm ?? RCA_ALGORITHM,
    source: candidate.source,
    evidence: candidate.evidence.map((item) => ({
      kind: item.kind,
      summary: item.summary,
      confidence: item.confidence,
      entityKey: item.entityKey,
      facts: item.facts,
    })),
    affectedEntities: candidate.affectedEntities ?? [],
    affectedServices: candidate.affectedServices ?? [],
    firstObservedAt: candidate.firstObservedAt?.toISOString(),
    subscores: candidate.subscores ?? {
      temporalScore: 0,
      topologyScore: 0,
      anomalyScore: 0,
      dependencyScore: 0,
      historicalScore: 0,
    },
    weights: candidate.weights ?? {
      temporal: 0,
      topology: 0,
      anomaly: 0,
      dependency: 0,
      historical: 0,
    },
  };
}
