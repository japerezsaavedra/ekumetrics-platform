import type { EventHeaders } from './event-bus';

export const OUTBOX_STATUS = {
  PENDING: 'pending',
  PUBLISHING: 'publishing',
  PUBLISHED: 'published',
  FAILED: 'failed',
} as const;

export type OutboxStatus = (typeof OUTBOX_STATUS)[keyof typeof OUTBOX_STATUS];

export type OutboxEnqueueInput = {
  tenantId: string;
  subject: string;
  idempotencyKey: string;
  payload: unknown;
  headers: EventHeaders;
};

export const EVENT_OUTBOX = Symbol('EVENT_OUTBOX');
