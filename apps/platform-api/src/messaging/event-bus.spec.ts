import { EventBusTimeoutError, EventBusValidationError } from './errors';
import { InMemoryIdempotencyStore } from './idempotency';
import { InMemoryEventBus } from './in-memory.event-bus';
import { EventSubjects } from './subjects';
import { buildHeaders } from './envelopes';

function message(payload: Record<string, unknown> = { ok: true }) {
  return {
    payload,
    headers: buildHeaders({
      tenantId: 'acme',
      correlationId: 'corr-1',
    }),
    idempotencyKey: `acme:${EventSubjects.EVENTS_INGESTED}:k1`,
  };
}

describe('InMemoryEventBus', () => {
  let store: InMemoryIdempotencyStore;
  let bus: InMemoryEventBus;

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
    bus = new InMemoryEventBus(store);
  });

  afterEach(async () => {
    await bus.close();
  });

  it('entrega el envelope al handler y exige ack explícito', async () => {
    const seen: unknown[] = [];
    await bus.subscribe(
      {
        subject: EventSubjects.EVENTS_INGESTED,
        consumerName: 'normalizer',
        backoffMs: [1],
      },
      async (msg, ctrl) => {
        seen.push(msg.payload);
        await ctrl.ack();
      },
    );
    const result = await bus.publish(EventSubjects.EVENTS_INGESTED, message());
    expect(result.duplicate).toBeUndefined();
    expect(seen).toEqual([{ ok: true }]);
  });

  it('rechaza subjects que no son de ekumetrics', async () => {
    await expect(bus.publish('other.topic', message())).rejects.toBeInstanceOf(
      EventBusValidationError,
    );
  });

  it('resuelve request cuando el handler responde', async () => {
    await bus.subscribe(
      {
        subject: EventSubjects.RCA_REQUESTED,
        consumerName: 'rca-worker',
        backoffMs: [1],
      },
      async (msg, ctrl) => {
        await ctrl.respond?.({
          incidentId: (msg.payload as { id: string }).id,
        });
        await ctrl.ack();
      },
    );
    const reply = await bus.request<{ id: string }, { incidentId: string }>(
      EventSubjects.RCA_REQUESTED,
      {
        ...message({ id: 'inc-1' }),
        idempotencyKey: 'acme:rca:inc-1',
      },
      { timeoutMs: 200 },
    );
    expect(reply).toEqual({ incidentId: 'inc-1' });
  });

  it('hace timeout si nadie responde el request', async () => {
    await expect(
      bus.request(EventSubjects.RCA_REQUESTED, message(), { timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(EventBusTimeoutError);
  });

  it('expone health disponible', async () => {
    expect(bus.health()).toEqual({ available: true, driver: 'memory' });
    expect(await bus.ping()).toBe(true);
  });
});

describe('EventSubjects', () => {
  it('centraliza el catálogo Wave 1 + Wave 2 + Wave 3 sin duplicar rca.*', () => {
    expect(Object.values(EventSubjects)).toEqual([
      'ekumetrics.events.ingested',
      'ekumetrics.events.correlated',
      'ekumetrics.topology.updated',
      'ekumetrics.anomalies.detected',
      'ekumetrics.incidents.created',
      'ekumetrics.incidents.updated',
      'ekumetrics.incidents.resolved',
      'ekumetrics.incidents.enrichment.requested',
      'ekumetrics.incidents.enriched',
      'ekumetrics.rca.requested',
      'ekumetrics.rca.completed',
      'ekumetrics.aiops.investigation.requested',
      'ekumetrics.aiops.investigation.started',
      'ekumetrics.aiops.investigation.completed',
      'ekumetrics.aiops.investigation.failed',
      'ekumetrics.aiops.agent.started',
      'ekumetrics.aiops.agent.completed',
    ]);
  });
});
