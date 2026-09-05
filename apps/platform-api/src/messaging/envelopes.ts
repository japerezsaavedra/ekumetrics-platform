import type { EventHeaders, OutboundMessage } from './event-bus';
import { EventBusValidationError } from './errors';
import { isEkumetricsSubject } from './subjects';

export type WireMessage<T> = {
  payload: T;
  headers: EventHeaders;
  idempotencyKey: string;
};

export type EventHeaderInput = Omit<
  EventHeaders,
  'contentType' | 'schemaVersion' | 'producedBy' | 'occurredAt'
> &
  Partial<
    Pick<
      EventHeaders,
      'contentType' | 'schemaVersion' | 'producedBy' | 'occurredAt'
    >
  >;

export function buildHeaders(input: EventHeaderInput): EventHeaders {
  if (!input.tenantId?.trim()) {
    throw new EventBusValidationError('tenantId is required');
  }
  if (!input.correlationId?.trim()) {
    throw new EventBusValidationError('correlationId is required');
  }
  return {
    tenantId: input.tenantId,
    siteId: input.siteId,
    agentId: input.agentId,
    incidentId: input.incidentId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    contentType: input.contentType ?? 'application/json',
    schemaVersion: input.schemaVersion ?? '1',
    producedBy: input.producedBy ?? 'platform-api',
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  };
}

export function assertPublishable(
  subject: string,
  message: OutboundMessage<unknown>,
): void {
  if (!isEkumetricsSubject(subject)) {
    throw new EventBusValidationError(`invalid subject: ${subject}`);
  }
  if (!message.idempotencyKey?.trim()) {
    throw new EventBusValidationError('idempotencyKey is required');
  }
  if (!message.headers?.tenantId?.trim()) {
    throw new EventBusValidationError('headers.tenantId is required');
  }
  if (!message.headers.correlationId?.trim()) {
    throw new EventBusValidationError('headers.correlationId is required');
  }
}

export function toWire<T>(message: OutboundMessage<T>): WireMessage<T> {
  return {
    payload: message.payload,
    headers: message.headers,
    idempotencyKey: message.idempotencyKey,
  };
}

export function fromWire<T>(value: unknown): WireMessage<T> {
  if (!value || typeof value !== 'object') {
    throw new EventBusValidationError('invalid event payload');
  }
  const wire = value as WireMessage<T>;
  if (!wire.headers || typeof wire.headers !== 'object') {
    throw new EventBusValidationError('event headers missing');
  }
  if (!wire.idempotencyKey) {
    throw new EventBusValidationError('idempotencyKey missing on wire message');
  }
  return wire;
}

export function tenantMismatchReason(
  headers: EventHeaders,
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const tenantId = (payload as { tenantId?: unknown }).tenantId;
  if (typeof tenantId !== 'string' || !tenantId) {
    return null;
  }
  if (tenantId !== headers.tenantId) {
    return 'tenantId header/payload mismatch';
  }
  return null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeWire<T>(message: OutboundMessage<T>): Uint8Array {
  return encoder.encode(JSON.stringify(toWire(message)));
}

export function decodeWire<T>(data: Uint8Array): WireMessage<T> {
  return fromWire<T>(JSON.parse(decoder.decode(data)));
}

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decodeJson<T>(data: Uint8Array): T {
  return JSON.parse(decoder.decode(data)) as T;
}
