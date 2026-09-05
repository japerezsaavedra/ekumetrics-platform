import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DegradedEventBus } from './degraded.event-bus';
import type { EventBus } from './event-bus';
import type { IdempotencyStore } from './idempotency';
import { InMemoryIdempotencyStore } from './idempotency';
import { InMemoryEventBus } from './in-memory.event-bus';
import { errorMessage, eventBusLog, eventBusWarn } from './log';
import { NatsJetStreamEventBus } from './nats-jetstream.event-bus';
import { EVENT_BUS, IDEMPOTENCY_STORE } from './tokens';
import { EventOutboxMetrics } from './event-outbox.metrics';
import { EventOutboxService } from './event-outbox.service';

export async function createEventBus(
  config: ConfigService,
  store: IdempotencyStore,
): Promise<EventBus> {
  const logger = new Logger('MessagingModule');
  const driver = (
    config.get<string>('EVENT_BUS_DRIVER') ?? defaultDriver()
  ).toLowerCase();
  if (driver === 'memory') {
    eventBusLog(logger, 'event_bus.driver', { driver: 'memory' });
    return new InMemoryEventBus(store);
  }
  const url = config.get<string>('NATS_URL') ?? '';
  if (!url) {
    eventBusWarn(logger, 'event_bus.degraded', {
      reason: 'NATS_URL missing',
    });
    return new DegradedEventBus();
  }
  const bus = new NatsJetStreamEventBus({
    url,
    token: config.get<string>('NATS_TOKEN') ?? undefined,
    connectTimeoutMs: integerEnv(config, 'EVENT_BUS_CONNECT_TIMEOUT_MS', 5_000),
    store,
  });
  try {
    await bus.connect();
    return bus;
  } catch (error) {
    eventBusWarn(logger, 'event_bus.degraded', {
      reason: errorMessage(error),
      url,
    });
    await bus.close().catch(() => undefined);
    return new DegradedEventBus();
  }
}

function defaultDriver(): string {
  return process.env.NODE_ENV === 'test' ? 'memory' : 'nats';
}

function integerEnv(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = config.get<string>(key);
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

@Injectable()
class MessagingLifecycle implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('MessagingLifecycle');
  private readonly signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  private readonly onSignal = () => {
    void this.eventBus.close();
  };

  constructor(@Inject(EVENT_BUS) private readonly eventBus: EventBus) {}

  onModuleInit(): void {
    for (const signal of this.signals) {
      process.once(signal, this.onSignal);
    }
    eventBusLog(this.logger, 'event_bus.lifecycle', {
      driver: this.eventBus.driver,
      available: this.eventBus.isAvailable(),
    });
  }

  async onModuleDestroy(): Promise<void> {
    for (const signal of this.signals) {
      process.removeListener(signal, this.onSignal);
    }
    await this.eventBus.close();
  }
}

@Global()
@Module({
  providers: [
    InMemoryIdempotencyStore,
    {
      provide: IDEMPOTENCY_STORE,
      useExisting: InMemoryIdempotencyStore,
    },
    {
      provide: EVENT_BUS,
      useFactory: createEventBus,
      inject: [ConfigService, IDEMPOTENCY_STORE],
    },
    EventOutboxMetrics,
    EventOutboxService,
    MessagingLifecycle,
  ],
  exports: [EVENT_BUS, EventOutboxService, EventOutboxMetrics],
})
export class MessagingModule {}
