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
  type EventBus,
  type Subscription,
} from '../../messaging';
import type { RcaCompletedPayload } from '../rca/types';
import { IncidentEnrichmentService } from './incident-enrichment.service';

@Injectable()
export class IncidentRcaCompletedSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(IncidentRcaCompletedSubscriber.name);
  private subscription?: Subscription;

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    private readonly enrichment: IncidentEnrichmentService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus.isAvailable()) {
      this.logger.log(
        'aiops rca.completed subscriber skipped event_bus_unavailable',
      );
      return;
    }
    this.subscription = await this.eventBus.subscribe<RcaCompletedPayload>(
      {
        subject: EventSubjects.RCA_COMPLETED,
        consumerName: 'aiops-incident-rca-completed',
        queueGroup: 'aiops-incident-rca-completed',
      },
      async (msg, ctrl) => {
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
          await this.enrichment.applyRcaCompleted(
            tenantId,
            incidentId,
            msg.payload,
          );
          await ctrl.ack();
        } catch (error) {
          this.logger.warn(
            `aiops rca.completed persist failed tenantId=${tenantId} incidentId=${incidentId} error=${error instanceof Error ? error.message : 'unknown'}`,
          );
          await ctrl.nak();
        }
      },
    );
    this.logger.log('aiops rca.completed subscriber subscribed');
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscription?.unsubscribe();
  }
}
