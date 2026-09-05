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
  type InboundMessage,
  type MessageControl,
  type Subscription,
} from '../../messaging';
import { AnomalyEngine } from './anomaly.engine';
import { ANOMALY_WORKER_CONSUMER } from './anomaly.tokens';
import { parseMetricSamples } from './metric-sample';

/**
 * Consume `ekumetrics.events.ingested` y corre detección en el worker.
 * No se ejecuta en el path HTTP de ingest.
 */
@Injectable()
export class AnomalyWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnomalyWorker.name);
  private subscription?: Subscription;

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    private readonly engine: AnomalyEngine,
  ) {}

  async onModuleInit(): Promise<void> {
    this.subscription = await this.eventBus.subscribe(
      {
        subject: EventSubjects.EVENTS_INGESTED,
        consumerName: ANOMALY_WORKER_CONSUMER,
        startPolicy: 'new',
        queueGroup: ANOMALY_WORKER_CONSUMER,
      },
      (msg, ctrl) => this.handle(msg, ctrl),
    );
    this.logger.log(
      JSON.stringify({
        event: 'aiops.anomaly.worker.started',
        consumerName: ANOMALY_WORKER_CONSUMER,
        driver: this.eventBus.driver,
        available: this.eventBus.isAvailable(),
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscription?.unsubscribe();
  }

  async handle(
    msg: InboundMessage<unknown>,
    ctrl: MessageControl,
  ): Promise<void> {
    const tenantId = msg.headers.tenantId;
    if (!tenantId) {
      await ctrl.term('missing tenantId');
      return;
    }
    const payloadTenant =
      msg.payload &&
      typeof msg.payload === 'object' &&
      'tenantId' in msg.payload
        ? (msg.payload as { tenantId?: unknown }).tenantId
        : undefined;
    if (typeof payloadTenant === 'string' && payloadTenant !== tenantId) {
      await ctrl.term('tenantId header/payload mismatch');
      return;
    }
    const samples = parseMetricSamples(msg.payload, tenantId);
    if (!samples.length) {
      await ctrl.ack();
      return;
    }
    try {
      await this.engine.ingestAndDetect(samples, Date.now());
      await ctrl.ack();
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'aiops.anomaly.worker.failed',
          tenantId,
          error: error instanceof Error ? error.message : 'unknown',
        }),
      );
      await ctrl.nak();
    }
  }
}
