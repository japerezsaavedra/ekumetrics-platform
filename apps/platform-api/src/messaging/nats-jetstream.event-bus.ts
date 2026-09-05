/**
 * Único adaptador que importa el SDK NATS.
 * El dominio no debe importar este archivo.
 */
import { Logger } from '@nestjs/common';
import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
  JetStreamApiError,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
} from '@nats-io/jetstream';
import {
  connect,
  headers as natsHeaders,
  nanos,
  type NatsConnection,
} from '@nats-io/transport-node';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  type EventBus,
  type EventBusDriver,
  type EventBusHealth,
  type EventHeaders,
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
import { EventBusUnavailableError, EventBusValidationError } from './errors';
import {
  assertPublishable,
  decodeJson,
  decodeWire,
  encodeJson,
  encodeWire,
  tenantMismatchReason,
  toWire,
} from './envelopes';
import { type IdempotencyStore, wrapIdempotentHandler } from './idempotency';
import { errorMessage, eventBusError, eventBusLog, eventBusWarn } from './log';
import { DLQ_PREFIX, toDeadLetterSubject } from './subjects';
import { withMessagingSpan } from './tracing';

const DAY_MS = 24 * 60 * 60 * 1000;

type StreamDef = {
  name: string;
  subjects: string[];
  maxAgeMs: number;
};

const STREAMS: StreamDef[] = [
  {
    name: 'EKU_EVENTS',
    subjects: ['ekumetrics.events.>'],
    maxAgeMs: 7 * DAY_MS,
  },
  {
    name: 'EKU_TOPOLOGY',
    subjects: ['ekumetrics.topology.>'],
    maxAgeMs: 7 * DAY_MS,
  },
  {
    name: 'EKU_ANOMALIES',
    subjects: ['ekumetrics.anomalies.>'],
    maxAgeMs: 7 * DAY_MS,
  },
  {
    name: 'EKU_INCIDENTS',
    subjects: ['ekumetrics.incidents.>'],
    maxAgeMs: 30 * DAY_MS,
  },
  { name: 'EKU_RCA', subjects: ['ekumetrics.rca.>'], maxAgeMs: 14 * DAY_MS },
  {
    name: 'EKU_AIOPS',
    subjects: ['ekumetrics.aiops.>'],
    maxAgeMs: 14 * DAY_MS,
  },
  { name: 'EKU_DLQ', subjects: [`${DLQ_PREFIX}.>`], maxAgeMs: 30 * DAY_MS },
];

const HEADER_KEYS = {
  tenantId: 'Eku-Tenant-Id',
  siteId: 'Eku-Site-Id',
  agentId: 'Eku-Agent-Id',
  incidentId: 'Eku-Incident-Id',
  correlationId: 'Eku-Correlation-Id',
  causationId: 'Eku-Causation-Id',
  contentType: 'Eku-Content-Type',
  schemaVersion: 'Eku-Schema-Version',
  producedBy: 'Eku-Produced-By',
  occurredAt: 'Eku-Occurred-At',
  idempotencyKey: 'Eku-Idempotency-Key',
} as const;

export type NatsJetStreamOptions = {
  url: string;
  token?: string;
  connectTimeoutMs?: number;
  store: IdempotencyStore;
};

type ActivePull = {
  consumerName: string;
  messages: ConsumerMessages;
};

export class NatsJetStreamEventBus implements EventBus {
  readonly driver: EventBusDriver = 'nats';
  private readonly logger = new Logger(NatsJetStreamEventBus.name);
  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;
  private readonly pulls = new Map<string, ActivePull>();
  private closed = false;

  constructor(private readonly options: NatsJetStreamOptions) {}

  async connect(): Promise<void> {
    const nc = await connect({
      servers: this.options.url,
      token: this.options.token || undefined,
      name: 'ekumetrics-platform-api',
      timeout: this.options.connectTimeoutMs ?? 5_000,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2_000,
    });
    this.nc = nc;
    this.jsm = await jetstreamManager(nc);
    this.js = jetstream(nc);
    await this.ensureStreams();
    eventBusLog(this.logger, 'event_bus.connected', {
      driver: this.driver,
      url: this.options.url,
    });
  }

  isAvailable(): boolean {
    return Boolean(this.nc) && !this.nc!.isClosed() && !this.closed;
  }

  async ping(): Promise<boolean> {
    if (!this.isAvailable() || !this.nc) {
      return false;
    }
    try {
      await this.nc.flush();
      return true;
    } catch {
      return false;
    }
  }

  health(): EventBusHealth {
    return { available: this.isAvailable(), driver: this.driver };
  }

  async publish<T>(
    subject: string,
    message: OutboundMessage<T>,
  ): Promise<PublishResult> {
    this.assertReady();
    assertPublishable(subject, message);
    return withMessagingSpan(
      'messaging.publish',
      {
        'messaging.system': 'nats',
        'messaging.destination': subject,
        'tenant.id': message.headers.tenantId,
      },
      async () => {
        const h = this.toNatsHeaders(message);
        const ack = await this.js!.publish(subject, encodeWire(message), {
          msgID: message.idempotencyKey,
          headers: h,
        });
        eventBusLog(this.logger, 'event_bus.publish.ok', {
          subject,
          tenantId: message.headers.tenantId,
          correlationId: message.headers.correlationId,
          idempotencyKey: message.idempotencyKey,
          messageId: String(ack.seq),
          duplicate: ack.duplicate,
          stream: ack.stream,
        });
        return { messageId: String(ack.seq), duplicate: ack.duplicate };
      },
    );
  }

  async subscribe<T>(
    opts: SubscribeOptions,
    handler: MessageHandler<T>,
  ): Promise<Subscription> {
    this.assertReady();
    if (!opts.consumerName?.trim()) {
      throw new EventBusValidationError('consumerName is required');
    }
    if (!/^[A-Za-z0-9_-]+$/.test(opts.consumerName)) {
      throw new EventBusValidationError(
        'consumerName must match [A-Za-z0-9_-]+',
      );
    }
    if (this.pulls.has(opts.consumerName)) {
      throw new EventBusValidationError(
        `consumer already subscribed: ${opts.consumerName}`,
      );
    }
    const resolved = resolveSubscribeOptions(opts);
    const stream = streamForSubject(opts.subject);
    await this.ensureConsumer(stream, resolved);
    const consumer = await this.js!.consumers.get(stream, opts.consumerName);
    const messages = await consumer.consume();
    this.pulls.set(opts.consumerName, {
      consumerName: opts.consumerName,
      messages,
    });
    const wrapped = wrapIdempotentHandler(
      opts.consumerName,
      this.options.store,
      handler,
    );
    void this.consumeLoop(opts.consumerName, resolved, messages, wrapped);
    eventBusLog(this.logger, 'event_bus.subscribe', {
      subject: opts.subject,
      consumerName: opts.consumerName,
      stream,
      durable: true,
      ackPolicy: 'explicit',
    });
    return {
      unsubscribe: async () => {
        const active = this.pulls.get(opts.consumerName);
        this.pulls.delete(opts.consumerName);
        active?.messages.stop();
        await active?.messages.close();
      },
    };
  }

  async request<TReq, TRes>(
    subject: string,
    message: OutboundMessage<TReq>,
    opts?: RequestOptions,
  ): Promise<TRes> {
    this.assertReady();
    assertPublishable(subject, message);
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return withMessagingSpan(
      'messaging.request',
      {
        'messaging.system': 'nats',
        'messaging.destination': subject,
        'tenant.id': message.headers.tenantId,
      },
      async () => {
        const reply = await this.nc!.request(subject, encodeWire(message), {
          timeout: timeoutMs,
          headers: this.toNatsHeaders(message),
        });
        return decodeJson<TRes>(reply.data);
      },
    );
  }

  async seek(consumer: string, position: SeekPosition): Promise<void> {
    this.assertReady();
    const active = this.pulls.get(consumer);
    const filter = await this.findConsumerFilter(consumer);
    if (!filter) {
      throw new EventBusValidationError(`unknown consumer: ${consumer}`);
    }
    if (active) {
      active.messages.stop();
      await active.messages.close();
      this.pulls.delete(consumer);
    }
    await this.jsm!.consumers.delete(filter.stream, consumer);
    eventBusLog(this.logger, 'event_bus.seek', {
      consumerName: consumer,
      position: position.type,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const active of this.pulls.values()) {
      try {
        active.messages.stop();
        await active.messages.close();
      } catch (error) {
        eventBusWarn(this.logger, 'event_bus.consumer_stop_error', {
          consumerName: active.consumerName,
          error: errorMessage(error),
        });
      }
    }
    this.pulls.clear();
    if (this.nc && !this.nc.isClosed()) {
      try {
        await this.nc.drain();
      } catch {
        await this.nc.close();
      }
    }
    this.nc = undefined;
    this.js = undefined;
    this.jsm = undefined;
    eventBusLog(this.logger, 'event_bus.closed', { driver: this.driver });
  }

  private assertReady(): void {
    if (
      !this.nc ||
      !this.js ||
      !this.jsm ||
      this.closed ||
      this.nc.isClosed()
    ) {
      throw new EventBusUnavailableError();
    }
  }

  private async ensureStreams(): Promise<void> {
    for (const def of STREAMS) {
      try {
        await this.jsm!.streams.info(def.name);
        await this.jsm!.streams.update(def.name, {
          subjects: def.subjects,
          max_age: nanos(def.maxAgeMs),
        });
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
        await this.jsm!.streams.add({
          name: def.name,
          subjects: def.subjects,
          retention: RetentionPolicy.Limits,
          storage: StorageType.File,
          max_age: nanos(def.maxAgeMs),
          duplicate_window: nanos(2 * 60 * 1000),
        });
        eventBusLog(this.logger, 'event_bus.stream_created', {
          stream: def.name,
          subjects: def.subjects,
        });
      }
    }
  }

  private async ensureConsumer(
    stream: string,
    opts: ReturnType<typeof resolveSubscribeOptions>,
  ): Promise<void> {
    const deliverPolicy = toDeliverPolicy(opts.startPolicy);
    const config = {
      durable_name: opts.consumerName,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: deliverPolicy,
      replay_policy: ReplayPolicy.Instant,
      filter_subject: opts.subject,
      max_deliver: opts.maxDeliveries,
      ack_wait: nanos(opts.ackWaitMs),
      backoff: opts.backoffMs.map((ms) => nanos(ms)),
      ...(opts.startPolicy === 'sequence' && typeof opts.startAt === 'number'
        ? { opt_start_seq: opts.startAt }
        : {}),
      ...(opts.startPolicy === 'timestamp' && typeof opts.startAt === 'string'
        ? { opt_start_time: opts.startAt }
        : {}),
    };
    try {
      await this.jsm!.consumers.add(stream, config);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }
  }

  private async consumeLoop<T>(
    consumerName: string,
    opts: ReturnType<typeof resolveSubscribeOptions>,
    messages: ConsumerMessages,
    handler: MessageHandler<T>,
  ): Promise<void> {
    try {
      for await (const raw of messages) {
        await this.handleJsMsg(opts, raw, handler);
      }
    } catch (error) {
      if (!this.closed) {
        eventBusError(this.logger, 'event_bus.consume_loop_error', {
          consumerName,
          error: errorMessage(error),
        });
      }
    }
  }

  private async handleJsMsg<T>(
    opts: ReturnType<typeof resolveSubscribeOptions>,
    raw: JsMsg,
    handler: MessageHandler<T>,
  ): Promise<void> {
    const attempt = raw.info.deliveryCount;
    let wire;
    try {
      wire = decodeWire<T>(raw.data);
    } catch (error) {
      eventBusError(this.logger, 'event_bus.poison_payload', {
        subject: raw.subject,
        error: errorMessage(error),
      });
      await this.deadLetter(opts, raw, 'invalid payload', attempt);
      raw.term('invalid payload');
      return;
    }
    if (opts.filterTenantId && opts.filterTenantId !== wire.headers.tenantId) {
      raw.ack();
      return;
    }
    const mismatch = tenantMismatchReason(wire.headers, wire.payload);
    if (mismatch) {
      await this.deadLetter(opts, raw, mismatch, attempt, wire);
      raw.term(mismatch);
      return;
    }
    const inbound: InboundMessage<T> = {
      subject: raw.subject,
      payload: wire.payload,
      headers: wire.headers,
      idempotencyKey: wire.idempotencyKey,
      attempt,
      ackRef: `js:${raw.info.stream}:${raw.seq}:${attempt}`,
    };
    let settled = false;
    const ctrl: MessageControl = {
      ack: async () => {
        settled = true;
        raw.ack();
      },
      nak: async (delayMs) => {
        settled = true;
        const delay =
          delayMs ??
          opts.backoffMs[Math.min(attempt - 1, opts.backoffMs.length - 1)];
        if (attempt >= opts.maxDeliveries) {
          await this.deadLetter(opts, raw, 'max deliveries', attempt, wire);
          raw.term('max deliveries');
          return;
        }
        raw.nak(delay);
      },
      term: async (reason) => {
        settled = true;
        await this.deadLetter(opts, raw, reason, attempt, wire);
        raw.term(reason);
      },
      respond: async (payload) => {
        const reply = (raw as JsMsg & { reply?: string }).reply;
        if (reply && this.nc) {
          this.nc.publish(reply, encodeJson(payload));
        }
      },
    };
    try {
      await withMessagingSpan(
        'messaging.consume',
        {
          'messaging.system': 'nats',
          'messaging.destination': raw.subject,
          'tenant.id': wire.headers.tenantId,
          'messaging.operation': 'process',
        },
        () => handler(inbound, ctrl),
      );
      if (!settled) {
        eventBusWarn(this.logger, 'event_bus.handler_unsettle', {
          subject: raw.subject,
          consumerName: opts.consumerName,
          action: 'nak',
        });
        await ctrl.nak();
      }
    } catch (error) {
      if (settled) {
        return;
      }
      eventBusError(this.logger, 'event_bus.handler_error', {
        subject: raw.subject,
        consumerName: opts.consumerName,
        attempt,
        error: errorMessage(error),
      });
      await ctrl.nak();
    }
  }

  private async deadLetter(
    opts: ReturnType<typeof resolveSubscribeOptions>,
    raw: JsMsg,
    reason: string,
    attempt: number,
    wire?: ReturnType<typeof toWire>,
  ): Promise<void> {
    const originalSubject = raw.subject;
    const dlq = toDeadLetterSubject(originalSubject);
    eventBusWarn(this.logger, 'event_bus.dead_letter', {
      subject: dlq,
      originalSubject,
      attempt,
      reason,
      consumerName: opts.consumerName,
    });
    if (!this.js) {
      return;
    }
    try {
      await this.js.publish(
        dlq,
        encodeJson({
          originalSubject,
          reason,
          attempt,
          failedAt: new Date().toISOString(),
          message: wire,
        }),
        { msgID: `${raw.seq}:dlq:${attempt}:${reason}` },
      );
    } catch (error) {
      eventBusError(this.logger, 'event_bus.dead_letter_failed', {
        subject: dlq,
        error: errorMessage(error),
      });
    }
  }

  private toNatsHeaders(message: OutboundMessage<unknown>) {
    const h = natsHeaders();
    const set = (key: string, value: string | undefined) => {
      if (value) {
        h.set(key, value);
      }
    };
    const headers: EventHeaders = message.headers;
    set(HEADER_KEYS.tenantId, headers.tenantId);
    set(HEADER_KEYS.siteId, headers.siteId);
    set(HEADER_KEYS.agentId, headers.agentId);
    set(HEADER_KEYS.incidentId, headers.incidentId);
    set(HEADER_KEYS.correlationId, headers.correlationId);
    set(HEADER_KEYS.causationId, headers.causationId);
    set(HEADER_KEYS.contentType, headers.contentType);
    set(HEADER_KEYS.schemaVersion, headers.schemaVersion);
    set(HEADER_KEYS.producedBy, headers.producedBy);
    set(HEADER_KEYS.occurredAt, headers.occurredAt);
    set(HEADER_KEYS.idempotencyKey, message.idempotencyKey);
    return h;
  }

  private async findConsumerFilter(
    consumerName: string,
  ): Promise<{ stream: string } | undefined> {
    for (const def of STREAMS) {
      try {
        await this.jsm!.consumers.info(def.name, consumerName);
        return { stream: def.name };
      } catch {
        continue;
      }
    }
    return undefined;
  }
}

function toDeliverPolicy(
  startPolicy: SubscribeOptions['startPolicy'],
): DeliverPolicy {
  switch (startPolicy) {
    case 'all':
      return DeliverPolicy.All;
    case 'sequence':
      return DeliverPolicy.StartSequence;
    case 'timestamp':
      return DeliverPolicy.StartTime;
    case 'new':
    default:
      return DeliverPolicy.New;
  }
}

export function streamForSubject(subject: string): string {
  if (subject.startsWith('ekumetrics.events.')) return 'EKU_EVENTS';
  if (subject.startsWith('ekumetrics.topology.')) return 'EKU_TOPOLOGY';
  if (subject.startsWith('ekumetrics.anomalies.')) return 'EKU_ANOMALIES';
  if (subject.startsWith('ekumetrics.incidents.')) return 'EKU_INCIDENTS';
  if (subject.startsWith('ekumetrics.rca.')) return 'EKU_RCA';
  if (subject.startsWith('ekumetrics.aiops.')) return 'EKU_AIOPS';
  if (subject.startsWith(`${DLQ_PREFIX}.`)) return 'EKU_DLQ';
  throw new EventBusValidationError(`no stream mapped for subject: ${subject}`);
}

function isNotFound(error: unknown): boolean {
  if (error instanceof JetStreamApiError) {
    return error.status === 404 || error.code === 404 || error.code === 10059;
  }
  return /not found/i.test(errorMessage(error));
}

function isAlreadyExists(error: unknown): boolean {
  if (!(error instanceof JetStreamApiError)) {
    return /already (exists|in use)/i.test(errorMessage(error));
  }
  return error.code === 10058 || error.code === 10148 || error.status === 400;
}
