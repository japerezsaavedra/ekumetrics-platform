import { Logger } from '@nestjs/common';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  type EventBus,
  type EventBusDriver,
  type EventBusHealth,
  type InboundMessage,
  type MessageControl,
  type MessageHandler,
  type OutboundMessage,
  type PublishResult,
  type RequestOptions,
  type SeekPosition,
  type SubscribeOptions,
  type Subscription,
  resolveSubscribeOptions,
} from './event-bus';
import { EventBusTimeoutError, EventBusValidationError } from './errors';
import { assertPublishable, tenantMismatchReason, toWire } from './envelopes';
import { type IdempotencyStore, wrapIdempotentHandler } from './idempotency';
import { errorMessage, eventBusError, eventBusLog, eventBusWarn } from './log';
import { toDeadLetterSubject } from './subjects';
import { withMessagingSpan } from './tracing';

type PendingRequest = {
  subject: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type ActiveConsumer = {
  opts: ReturnType<typeof resolveSubscribeOptions>;
  handler: MessageHandler<unknown>;
  closed: boolean;
};

export class InMemoryEventBus implements EventBus {
  readonly driver: EventBusDriver = 'memory';
  private readonly logger = new Logger(InMemoryEventBus.name);
  private readonly publishedKeys = new Map<string, string>();
  private readonly consumers = new Map<string, ActiveConsumer>();
  private readonly pending: PendingRequest[] = [];
  private seq = 0;
  private closed = false;

  constructor(private readonly store: IdempotencyStore) {}

  isAvailable(): boolean {
    return !this.closed;
  }

  async ping(): Promise<boolean> {
    return this.isAvailable();
  }

  health(): EventBusHealth {
    return { available: this.isAvailable(), driver: this.driver };
  }

  async publish<T>(
    subject: string,
    message: OutboundMessage<T>,
  ): Promise<PublishResult> {
    this.assertOpen();
    assertPublishable(subject, message);
    return withMessagingSpan(
      'messaging.publish',
      {
        'messaging.system': 'inmemory',
        'messaging.destination': subject,
        'tenant.id': message.headers.tenantId,
      },
      async () => {
        const existing = this.publishedKeys.get(message.idempotencyKey);
        if (existing) {
          eventBusLog(this.logger, 'event_bus.publish.duplicate', {
            subject,
            tenantId: message.headers.tenantId,
            idempotencyKey: message.idempotencyKey,
            messageId: existing,
          });
          return { messageId: existing, duplicate: true };
        }
        const messageId = `mem-${++this.seq}`;
        this.publishedKeys.set(message.idempotencyKey, messageId);
        eventBusLog(this.logger, 'event_bus.publish.ok', {
          subject,
          tenantId: message.headers.tenantId,
          correlationId: message.headers.correlationId,
          idempotencyKey: message.idempotencyKey,
          messageId,
        });
        await this.deliver(subject, message, 1, message.deadLetterSubject);
        return { messageId };
      },
    );
  }

  async subscribe<T>(
    opts: SubscribeOptions,
    handler: MessageHandler<T>,
  ): Promise<Subscription> {
    this.assertOpen();
    if (!opts.consumerName?.trim()) {
      throw new EventBusValidationError('consumerName is required');
    }
    if (this.consumers.has(opts.consumerName)) {
      throw new EventBusValidationError(
        `consumer already subscribed: ${opts.consumerName}`,
      );
    }
    const resolved = resolveSubscribeOptions(opts);
    this.consumers.set(opts.consumerName, {
      opts: resolved,
      handler: wrapIdempotentHandler(
        opts.consumerName,
        this.store,
        handler as MessageHandler<unknown>,
      ),
      closed: false,
    });
    eventBusLog(this.logger, 'event_bus.subscribe', {
      subject: opts.subject,
      consumerName: opts.consumerName,
      durable: true,
    });
    return {
      unsubscribe: async () => {
        this.consumers.delete(opts.consumerName);
      },
    };
  }

  async request<TReq, TRes>(
    subject: string,
    message: OutboundMessage<TReq>,
    opts?: RequestOptions,
  ): Promise<TRes> {
    this.assertOpen();
    assertPublishable(subject, message);
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return withMessagingSpan(
      'messaging.request',
      {
        'messaging.system': 'inmemory',
        'messaging.destination': subject,
        'tenant.id': message.headers.tenantId,
      },
      () =>
        new Promise<TRes>((resolve, reject) => {
          const pending: PendingRequest = {
            subject,
            resolve: (value) => {
              clearTimeout(pending.timer);
              resolve(value as TRes);
            },
            reject: (error) => {
              clearTimeout(pending.timer);
              reject(error);
            },
            timer: setTimeout(() => {
              this.removePending(pending);
              reject(new EventBusTimeoutError());
            }, timeoutMs),
          };
          this.pending.push(pending);
          void this.deliver(
            subject,
            message,
            1,
            message.deadLetterSubject,
          ).catch((error) => {
            this.removePending(pending);
            pending.reject(
              error instanceof Error ? error : new Error(errorMessage(error)),
            );
          });
        }),
    );
  }

  async seek(_consumer: string, _position: SeekPosition): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.consumers.clear();
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(new EventBusTimeoutError('event bus closed'));
    }
    eventBusLog(this.logger, 'event_bus.closed', { driver: this.driver });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new EventBusValidationError('event bus is closed');
    }
  }

  private removePending(pending: PendingRequest): void {
    const index = this.pending.indexOf(pending);
    if (index >= 0) {
      this.pending.splice(index, 1);
    }
  }

  private matchingConsumers(subject: string): ActiveConsumer[] {
    const matched = [...this.consumers.values()].filter(
      (consumer) =>
        !consumer.closed && this.subjectMatches(consumer.opts.subject, subject),
    );
    const chosen: ActiveConsumer[] = [];
    const groups = new Map<string, ActiveConsumer[]>();
    for (const consumer of matched) {
      if (!consumer.opts.queueGroup) {
        chosen.push(consumer);
        continue;
      }
      const list = groups.get(consumer.opts.queueGroup) ?? [];
      list.push(consumer);
      groups.set(consumer.opts.queueGroup, list);
    }
    for (const list of groups.values()) {
      chosen.push(list[0]);
    }
    return chosen;
  }

  private subjectMatches(pattern: string, subject: string): boolean {
    if (pattern === subject) {
      return true;
    }
    if (pattern.endsWith('.>')) {
      return subject.startsWith(pattern.slice(0, -2));
    }
    if (pattern.includes('*')) {
      const regex = new RegExp(
        `^${pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+')}$`,
      );
      return regex.test(subject);
    }
    return false;
  }

  private async deliver<T>(
    subject: string,
    message: OutboundMessage<T>,
    attempt: number,
    deadLetterSubject: string | undefined,
  ): Promise<void> {
    const consumers = this.matchingConsumers(subject);
    await Promise.all(
      consumers.map((consumer) =>
        this.invoke(consumer, subject, message, attempt, deadLetterSubject),
      ),
    );
  }

  private async invoke<T>(
    consumer: ActiveConsumer,
    subject: string,
    message: OutboundMessage<T>,
    attempt: number,
    deadLetterSubject: string | undefined,
  ): Promise<void> {
    if (
      consumer.opts.filterTenantId &&
      consumer.opts.filterTenantId !== message.headers.tenantId
    ) {
      return;
    }
    const mismatch = tenantMismatchReason(message.headers, message.payload);
    const inbound: InboundMessage<T> = {
      subject,
      payload: message.payload,
      headers: message.headers,
      idempotencyKey: message.idempotencyKey,
      attempt,
      ackRef: `mem:${subject}:${this.seq}:${attempt}`,
    };
    let settled = false;
    const maxDeliveries = consumer.opts.maxDeliveries ?? 5;
    const backoffMs = consumer.opts.backoffMs ?? [];
    const dlq = deadLetterSubject ?? toDeadLetterSubject(subject);

    const settle = () => {
      settled = true;
    };

    const ctrl: MessageControl = {
      ack: async () => {
        settle();
      },
      nak: async (delayMs) => {
        settle();
        await this.retryOrDlq(
          consumer,
          subject,
          message,
          attempt,
          delayMs ??
            backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ??
            0,
          maxDeliveries,
          dlq,
          'nak',
        );
      },
      term: async (reason) => {
        settle();
        await this.publishDlq(dlq, subject, message, attempt, reason);
      },
      respond: async (payload) => {
        const pending = this.pending.find((item) => item.subject === subject);
        if (pending) {
          this.removePending(pending);
          pending.resolve(payload);
        }
      },
    };

    if (mismatch) {
      await ctrl.term(mismatch);
      return;
    }

    try {
      await withMessagingSpan(
        'messaging.consume',
        {
          'messaging.system': 'inmemory',
          'messaging.destination': subject,
          'tenant.id': message.headers.tenantId,
          'messaging.operation': 'process',
        },
        () => consumer.handler(inbound, ctrl),
      );
      if (!settled) {
        eventBusWarn(this.logger, 'event_bus.handler_unsettle', {
          subject,
          consumerName: consumer.opts.consumerName,
          action: 'nak',
        });
        await ctrl.nak();
      }
    } catch (error) {
      if (settled) {
        return;
      }
      eventBusError(this.logger, 'event_bus.handler_error', {
        subject,
        consumerName: consumer.opts.consumerName,
        attempt,
        error: errorMessage(error),
      });
      await ctrl.nak();
    }
  }

  private async retryOrDlq<T>(
    consumer: ActiveConsumer,
    subject: string,
    message: OutboundMessage<T>,
    attempt: number,
    delayMs: number,
    maxDeliveries: number,
    dlq: string,
    reason: string,
  ): Promise<void> {
    if (attempt >= maxDeliveries) {
      await this.publishDlq(dlq, subject, message, attempt, reason);
      return;
    }
    const wait = Math.max(0, delayMs);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    await this.invoke(consumer, subject, message, attempt + 1, dlq);
  }

  private async publishDlq<T>(
    dlq: string,
    originalSubject: string,
    message: OutboundMessage<T>,
    attempt: number,
    reason: string,
  ): Promise<void> {
    eventBusWarn(this.logger, 'event_bus.dead_letter', {
      subject: dlq,
      originalSubject,
      attempt,
      reason,
      tenantId: message.headers.tenantId,
      idempotencyKey: message.idempotencyKey,
    });
    const wire = toWire(message);
    await this.deliver(
      dlq,
      {
        payload: {
          originalSubject,
          reason,
          attempt,
          failedAt: new Date().toISOString(),
          message: wire,
        },
        headers: message.headers,
        idempotencyKey: `${message.idempotencyKey}:dlq:${attempt}`,
      },
      1,
      dlq,
    );
  }
}
