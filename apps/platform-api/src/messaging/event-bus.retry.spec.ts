import { InMemoryIdempotencyStore } from './idempotency';
import { InMemoryEventBus } from './in-memory.event-bus';
import { EventSubjects, toDeadLetterSubject } from './subjects';
import { buildHeaders } from './envelopes';

describe('EventBus retry y dead-letter', () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus(new InMemoryIdempotencyStore());
  });

  afterEach(async () => {
    await bus.close();
  });

  it('reintenta con backoff y ack en el último intento', async () => {
    const attempts: number[] = [];
    await bus.subscribe(
      {
        subject: EventSubjects.INCIDENTS_CREATED,
        consumerName: 'incident-writer',
        maxDeliveries: 3,
        backoffMs: [1, 1, 1],
      },
      async (msg, ctrl) => {
        attempts.push(msg.attempt);
        if (msg.attempt < 3) {
          await ctrl.nak(1);
          return;
        }
        await ctrl.ack();
      },
    );
    await bus.publish(EventSubjects.INCIDENTS_CREATED, {
      payload: { incidentId: 'i-1' },
      headers: buildHeaders({ tenantId: 'acme', correlationId: 'c1' }),
      idempotencyKey: 'acme:incidents.created:i-1',
    });
    expect(attempts).toEqual([1, 2, 3]);
  });

  it('publica en DLQ tras maxDeliveries o term', async () => {
    const dlq: Array<{ reason: string; originalSubject: string }> = [];
    await bus.subscribe(
      {
        subject: EventSubjects.INCIDENTS_CREATED,
        consumerName: 'poison-worker',
        maxDeliveries: 2,
        backoffMs: [1],
      },
      async (_msg, ctrl) => {
        await ctrl.nak(1);
      },
    );
    await bus.subscribe(
      {
        subject: toDeadLetterSubject(EventSubjects.INCIDENTS_CREATED),
        consumerName: 'dlq-reader',
        backoffMs: [1],
      },
      async (msg, ctrl) => {
        const payload = msg.payload as {
          reason: string;
          originalSubject: string;
        };
        dlq.push(payload);
        await ctrl.ack();
      },
    );
    await bus.publish(EventSubjects.INCIDENTS_CREATED, {
      payload: { incidentId: 'i-2' },
      headers: buildHeaders({ tenantId: 'acme', correlationId: 'c2' }),
      idempotencyKey: 'acme:incidents.created:i-2',
    });
    expect(dlq).toMatchObject([
      {
        reason: 'nak',
        originalSubject: EventSubjects.INCIDENTS_CREATED,
      },
    ]);
  });

  it('termina de inmediato con term y no reintenta', async () => {
    const attempts: number[] = [];
    const dlq: string[] = [];
    await bus.subscribe(
      {
        subject: EventSubjects.EVENTS_CORRELATED,
        consumerName: 'corr-worker',
        maxDeliveries: 5,
        backoffMs: [1],
      },
      async (msg, ctrl) => {
        attempts.push(msg.attempt);
        await ctrl.term('poison');
      },
    );
    await bus.subscribe(
      {
        subject: toDeadLetterSubject(EventSubjects.EVENTS_CORRELATED),
        consumerName: 'dlq-corr',
        backoffMs: [1],
      },
      async (msg, ctrl) => {
        dlq.push((msg.payload as { reason: string }).reason);
        await ctrl.ack();
      },
    );
    await bus.publish(EventSubjects.EVENTS_CORRELATED, {
      payload: { clusterKey: 'k' },
      headers: buildHeaders({ tenantId: 'acme', correlationId: 'c3' }),
      idempotencyKey: 'acme:events.correlated:k',
    });
    expect(attempts).toEqual([1]);
    expect(dlq).toEqual(['poison']);
  });
});
