import { Logger } from '@nestjs/common';
import type {
  EventBus,
  EventBusDriver,
  EventBusHealth,
  MessageHandler,
  OutboundMessage,
  PublishResult,
  RequestOptions,
  SubscribeOptions,
  Subscription,
} from './event-bus';
import { EventBusUnavailableError } from './errors';
import { eventBusWarn } from './log';

/** Bus no-op cuando NATS no está disponible. La API sigue arrancando. */
export class DegradedEventBus implements EventBus {
  readonly driver: EventBusDriver = 'degraded';
  private readonly logger = new Logger(DegradedEventBus.name);

  isAvailable(): boolean {
    return false;
  }

  async ping(): Promise<boolean> {
    return false;
  }

  health(): EventBusHealth {
    return { available: false, driver: this.driver };
  }

  async publish<T>(
    subject: string,
    _message: OutboundMessage<T>,
  ): Promise<PublishResult> {
    eventBusWarn(this.logger, 'event_bus.degraded_publish', { subject });
    throw new EventBusUnavailableError();
  }

  async subscribe<T>(
    opts: SubscribeOptions,
    _handler: MessageHandler<T>,
  ): Promise<Subscription> {
    eventBusWarn(this.logger, 'event_bus.degraded_subscribe', {
      subject: opts.subject,
      consumerName: opts.consumerName,
    });
    return { unsubscribe: async () => undefined };
  }

  async request<TReq, TRes>(
    subject: string,
    _message: OutboundMessage<TReq>,
    _opts?: RequestOptions,
  ): Promise<TRes> {
    eventBusWarn(this.logger, 'event_bus.degraded_request', { subject });
    throw new EventBusUnavailableError();
  }

  async close(): Promise<void> {
    return;
  }
}
