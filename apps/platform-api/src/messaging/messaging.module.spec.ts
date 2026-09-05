import { ConfigService } from '@nestjs/config';
import { DegradedEventBus } from './degraded.event-bus';
import { EventBusUnavailableError } from './errors';
import { InMemoryEventBus } from './in-memory.event-bus';
import { InMemoryIdempotencyStore } from './idempotency';
import { createEventBus } from './messaging.module';

describe('createEventBus', () => {
  const store = new InMemoryIdempotencyStore();

  it('usa memoria cuando EVENT_BUS_DRIVER=memory', async () => {
    const bus = await createEventBus(
      {
        get: (key: string) =>
          key === 'EVENT_BUS_DRIVER' ? 'memory' : undefined,
      } as ConfigService,
      store,
    );
    expect(bus).toBeInstanceOf(InMemoryEventBus);
    await bus.close();
  });

  it('degrada si falta NATS_URL', async () => {
    const bus = await createEventBus(
      {
        get: (key: string) => (key === 'EVENT_BUS_DRIVER' ? 'nats' : undefined),
      } as ConfigService,
      store,
    );
    expect(bus).toBeInstanceOf(DegradedEventBus);
    expect(bus.isAvailable()).toBe(false);
    await expect(
      bus.publish('ekumetrics.events.ingested', {
        payload: {},
        headers: {
          tenantId: 'acme',
          correlationId: 'c',
          contentType: 'application/json',
          schemaVersion: '1',
          producedBy: 'test',
          occurredAt: new Date().toISOString(),
        },
        idempotencyKey: 'k',
      }),
    ).rejects.toBeInstanceOf(EventBusUnavailableError);
  });
});
