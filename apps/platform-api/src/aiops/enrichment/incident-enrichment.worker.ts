import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  EVENT_BUS,
  EventSubjects,
  buildHeaders,
  type EventBus,
  type InboundMessage,
  type MessageControl,
  type Subscription,
} from '../../messaging';
import { IncidentEnrichmentPublisher } from './incident-enrichment.publisher';
import { IncidentEnrichmentService } from './incident-enrichment.service';
import type {
  EnrichmentRequestedPayload,
  IncidentEnrichedPayload,
} from './incident-enrichment.types';

/**
 * Worker EventBus. No corre dentro de la ingesta HTTP ni de correlate().
 */
@Injectable()
export class IncidentEnrichmentWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IncidentEnrichmentWorker.name);
  private subscription?: Subscription;

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    private readonly enrichment: IncidentEnrichmentService,
    @Optional() private readonly publisher?: IncidentEnrichmentPublisher,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus.isAvailable()) {
      this.logger.log(
        'aiops incident enrichment worker skipped event_bus_unavailable',
      );
      return;
    }
    this.subscription = await this.eventBus.subscribe<EnrichmentRequestedPayload>(
      {
        subject: EventSubjects.INCIDENTS_ENRICHMENT_REQUESTED,
        consumerName: 'aiops-incident-enrichment',
        queueGroup: 'aiops-incident-enrichment',
      },
      (msg, ctrl) => this.handle(msg, ctrl),
    );
    this.logger.log('aiops incident enrichment worker subscribed');
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscription?.unsubscribe();
  }

  async handle(
    msg: InboundMessage<EnrichmentRequestedPayload>,
    ctrl: MessageControl,
  ): Promise<void> {
    const tenantId = msg.payload?.tenantId || msg.headers.tenantId;
    const incidentId = msg.payload?.incidentId || msg.headers.incidentId;
    if (!tenantId || !incidentId) {
      await ctrl.term('missing tenantId or incidentId');
      return;
    }
    if (msg.headers.tenantId && msg.headers.tenantId !== tenantId) {
      await ctrl.term('tenantId header/payload mismatch');
      return;
    }
    try {
      const result = await this.enrichment.enrich(tenantId, incidentId);
      await ctrl.ack();
      if (!result) return;
      await this.publishEnriched(result);
      await this.publisher?.requestRca({
        id: result.incidentId,
        tenantId: result.tenantId,
      });
    } catch (error) {
      this.logger.error(
        `aiops incident enrichment worker failed tenantId=${tenantId} incidentId=${incidentId} error=${error instanceof Error ? error.message : 'unknown'}`,
      );
      await ctrl.nak();
    }
  }

  private async publishEnriched(result: {
    tenantId: string;
    incidentId: string;
    algorithm: string;
    source: string;
    score: number;
    confidence: number;
    computedPriority: { level: IncidentEnrichedPayload['priority'] };
    rcaConfidence: number | null;
  }): Promise<void> {
    const payload: IncidentEnrichedPayload = {
      tenantId: result.tenantId,
      incidentId: result.incidentId,
      algorithm: result.algorithm,
      source: result.source,
      score: result.score,
      confidence: result.confidence,
      priority: result.computedPriority.level,
      rcaConfidence: result.rcaConfidence,
    };
    await this.eventBus.publish(EventSubjects.INCIDENTS_ENRICHED, {
      payload,
      headers: buildHeaders({
        tenantId: result.tenantId,
        incidentId: result.incidentId,
        correlationId: `enriched:${result.incidentId}`,
        producedBy: 'aiops.incident-enrichment',
      }),
      idempotencyKey: `${result.tenantId}:incidents.enriched:${result.incidentId}:${result.score}`,
    });
  }
}
