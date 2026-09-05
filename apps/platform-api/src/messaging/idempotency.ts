import { Logger } from '@nestjs/common';
import type {
  InboundMessage,
  MessageControl,
  MessageHandler,
} from './event-bus';
import { eventBusLog } from './log';

/**
 * Store de idempotencia de aplicación (capa 2).
 * Capa 1 es Nats-Msg-Id en el broker.
 * Esta implementación de Wave 1 es in-memory (por proceso).
 * No toca AgentEvent. Una tabla dedicada (p.ej. MessageDedupe) queda
 * para cuando haya réplicas y side effects no idempotentes.
 */
export interface IdempotencyStore {
  wasProcessed(consumerName: string, idempotencyKey: string): Promise<boolean>;
  markProcessed(consumerName: string, idempotencyKey: string): Promise<void>;
  clear?(): Promise<void>;
}

type Entry = {
  processedAt: number;
};

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  async wasProcessed(
    consumerName: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    this.evictExpired();
    const entry = this.entries.get(this.key(consumerName, idempotencyKey));
    return Boolean(entry);
  }

  async markProcessed(
    consumerName: string,
    idempotencyKey: string,
  ): Promise<void> {
    this.evictExpired();
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest) {
        this.entries.delete(oldest);
      }
    }
    this.entries.set(this.key(consumerName, idempotencyKey), {
      processedAt: Date.now(),
    });
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  private key(consumerName: string, idempotencyKey: string): string {
    return `${consumerName}\u0000${idempotencyKey}`;
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.processedAt < cutoff) {
        this.entries.delete(key);
      }
    }
  }
}

const logger = new Logger('IdempotencyStore');

export function wrapIdempotentHandler<T>(
  consumerName: string,
  store: IdempotencyStore,
  handler: MessageHandler<T>,
): MessageHandler<T> {
  return async (msg: InboundMessage<T>, ctrl: MessageControl) => {
    const seen = await store.wasProcessed(consumerName, msg.idempotencyKey);
    if (seen) {
      eventBusLog(logger, 'event_bus.duplicate_skipped', {
        consumerName,
        subject: msg.subject,
        tenantId: msg.headers.tenantId,
        idempotencyKey: msg.idempotencyKey,
        attempt: msg.attempt,
      });
      await ctrl.ack();
      return;
    }
    const wrapping: MessageControl = {
      ack: async () => {
        await store.markProcessed(consumerName, msg.idempotencyKey);
        await ctrl.ack();
      },
      nak: (delayMs) => ctrl.nak(delayMs),
      term: (reason) => ctrl.term(reason),
      respond: ctrl.respond ? (payload) => ctrl.respond!(payload) : undefined,
    };
    await handler(msg, wrapping);
  };
}
