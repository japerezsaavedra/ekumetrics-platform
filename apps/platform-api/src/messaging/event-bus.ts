export type EventBusDriver = 'nats' | 'memory' | 'degraded';

export type EventHeaders = {
  tenantId: string;
  siteId?: string;
  /** Identificador del recolector Ekumetrics Agent, cuando aplica. */
  agentId?: string;
  incidentId?: string;
  correlationId: string;
  causationId?: string;
  contentType: 'application/json';
  schemaVersion: string;
  producedBy: string;
  occurredAt: string;
};

export type OutboundMessage<T> = {
  payload: T;
  headers: EventHeaders;
  /** Dedupe de publicación (Nats-Msg-Id) y de consumo (store). */
  idempotencyKey: string;
  deadLetterSubject?: string;
};

export type SubscribeOptions = {
  subject: string;
  consumerName: string;
  queueGroup?: string;
  maxDeliveries?: number;
  ackWaitMs?: number;
  backoffMs?: number[];
  filterTenantId?: string;
  startPolicy?: 'new' | 'all' | 'timestamp' | 'sequence';
  startAt?: string | number;
};

export type AckRef = string;

export type InboundMessage<T> = {
  subject: string;
  payload: T;
  headers: EventHeaders;
  idempotencyKey: string;
  attempt: number;
  ackRef: AckRef;
};

export type MessageControl = {
  ack(): Promise<void>;
  nak(delayMs?: number): Promise<void>;
  term(reason: string): Promise<void>;
  respond?(payload: unknown): Promise<void>;
};

export type MessageHandler<T> = (
  msg: InboundMessage<T>,
  ctrl: MessageControl,
) => Promise<void>;

export type Subscription = {
  unsubscribe(): Promise<void>;
};

export type PublishResult = {
  messageId: string;
  duplicate?: boolean;
};

export type SeekPosition =
  | { type: 'sequence'; seq: number }
  | { type: 'timestamp'; iso: string }
  | { type: 'all' }
  | { type: 'new' };

export type RequestOptions = {
  timeoutMs?: number;
};

export type EventBusHealth = {
  available: boolean;
  driver: EventBusDriver;
};

/**
 * Puerto de mensajería. El dominio solo depende de esta interfaz.
 * No importar el cliente NATS fuera del adaptador JetStream.
 */
export interface EventBus {
  readonly driver: EventBusDriver;
  publish<T>(
    subject: string,
    message: OutboundMessage<T>,
  ): Promise<PublishResult>;
  subscribe<T>(
    opts: SubscribeOptions,
    handler: MessageHandler<T>,
  ): Promise<Subscription>;
  request<TReq, TRes>(
    subject: string,
    message: OutboundMessage<TReq>,
    opts?: RequestOptions,
  ): Promise<TRes>;
  seek?(consumer: string, position: SeekPosition): Promise<void>;
  close(): Promise<void>;
  isAvailable(): boolean;
  ping(): Promise<boolean>;
  health(): EventBusHealth;
}

export const DEFAULT_MAX_DELIVERIES = 5;
export const DEFAULT_ACK_WAIT_MS = 30_000;
export const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export function resolveSubscribeOptions(
  opts: SubscribeOptions,
): Required<
  Pick<
    SubscribeOptions,
    'maxDeliveries' | 'ackWaitMs' | 'backoffMs' | 'startPolicy'
  >
> &
  SubscribeOptions {
  return {
    ...opts,
    maxDeliveries: opts.maxDeliveries ?? DEFAULT_MAX_DELIVERIES,
    ackWaitMs: opts.ackWaitMs ?? DEFAULT_ACK_WAIT_MS,
    backoffMs: opts.backoffMs ?? DEFAULT_BACKOFF_MS,
    startPolicy: opts.startPolicy ?? 'new',
  };
}
