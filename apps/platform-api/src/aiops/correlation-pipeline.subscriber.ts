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
} from '../messaging';
import {
  CORRELATION_PIPELINE_CONSUMER,
  type CorrelationPipelineConsumer,
} from './correlation-pipeline.port';

/**
 * Wave 3 hook. Wave 2.5 only forwards the signal to a no-op consumer so
 * POST /v1/incidents/correlate remains the product correlation path.
 */
@Injectable()
export class CorrelationPipelineSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CorrelationPipelineSubscriber.name);
  private subscription?: Subscription;

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    @Inject(CORRELATION_PIPELINE_CONSUMER)
    private readonly consumer: CorrelationPipelineConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus.isAvailable()) {
      this.logger.log(
        'aiops correlation pipeline subscriber skipped event_bus_unavailable',
      );
      return;
    }
    this.subscription = await this.eventBus.subscribe<{
      tenantId?: string;
      entityId?: string;
    }>(
      {
        subject: EventSubjects.ANOMALIES_DETECTED,
        consumerName: 'aiops-correlation-pipeline',
        queueGroup: 'aiops-correlation-pipeline',
      },
      async (msg, ctrl) => {
        const tenantId = msg.payload?.tenantId || msg.headers.tenantId;
        if (!tenantId) {
          await ctrl.term('missing tenantId');
          return;
        }
        if (msg.headers.tenantId && msg.headers.tenantId !== tenantId) {
          await ctrl.term('tenantId header/payload mismatch');
          return;
        }
        try {
          await this.consumer.onSignal({
            tenantId,
            reason: 'anomalies.detected',
            entityIds: msg.payload?.entityId
              ? [msg.payload.entityId]
              : undefined,
          });
          await ctrl.ack();
        } catch (error) {
          this.logger.warn(
            JSON.stringify({
              event: 'aiops.correlation.pipeline.signal_failed',
              tenantId,
              error: error instanceof Error ? error.message : 'unknown',
            }),
          );
          await ctrl.nak();
        }
      },
    );
    this.logger.log(
      'aiops correlation pipeline subscriber subscribed (deferred, no auto-correlate)',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscription?.unsubscribe();
  }
}
