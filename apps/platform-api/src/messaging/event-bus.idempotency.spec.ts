import { InMemoryIdempotencyStore, wrapIdempotentHandler } from './idempotency';
import { InMemoryEventBus } from './in-memory.event-bus';
import { EventSubjects } from './subjects';
import { buildHeaders } from './envelopes';
import type { InboundMessage, MessageControl } from './event-bus';

describe('Idempotencia del consumer', () => {
  it('el store evita una segunda mutación con la misma clave', async () => {
    const store = new InMemoryIdempotencyStore();
    let mutations = 0;
    const handler = wrapIdempotentHandler(
      'corr-worker',
      store,
      async (_msg, ctrl) => {
        mutations += 1;
        await ctrl.ack();
      },
    );
    const inbound = {
      subject: EventSubjects.EVENTS_CORRELATED,
      payload: { clusterKey: 'k' },
      headers: buildHeaders({ tenantId: 'acme', correlationId: 'c1' }),
      idempotencyKey: 'acme:events.correlated:k',
      attempt: 1,
      ackRef: 't1',
    } as InboundMessage<{ clusterKey: string }>;
    const acks: string[] = [];
    const ctrl: MessageControl = {
      ack: async () => {
        acks.push('ack');
      },
      nak: async () => {
        acks.push('nak');
      },
      term: async () => {
        acks.push('term');
      },
    };

    await handler(inbound, ctrl);
    await handler({ ...inbound, attempt: 2 }, ctrl);

    expect(mutations).toBe(1);
    expect(acks).toEqual(['ack', 'ack']);
  });

  it('publish duplicado no vuelve a entregar (Msg-Id de productor)', async () => {
    const bus = new InMemoryEventBus(new InMemoryIdempotencyStore());
    let deliveries = 0;
    await bus.subscribe(
      {
        subject: EventSubjects.TOPOLOGY_UPDATED,
        consumerName: 'topo-worker',
        backoffMs: [1],
      },
      async (_msg, ctrl) => {
        deliveries += 1;
        await ctrl.ack();
      },
    );
    const outbound = {
      payload: { nodeId: 'sw-1' },
      headers: buildHeaders({ tenantId: 'acme', correlationId: 'c1' }),
      idempotencyKey: 'acme:topology.updated:sw-1',
    };
    const first = await bus.publish(EventSubjects.TOPOLOGY_UPDATED, outbound);
    const second = await bus.publish(EventSubjects.TOPOLOGY_UPDATED, outbound);
    expect(first.duplicate).toBeUndefined();
    expect(second.duplicate).toBe(true);
    expect(second.messageId).toBe(first.messageId);
    expect(deliveries).toBe(1);
    await bus.close();
  });

  it('redelivery tras ack perdido no vuelve a mutar', async () => {
    const store = new InMemoryIdempotencyStore();
    const bus = new InMemoryEventBus(store);
    let mutations = 0;
    await bus.subscribe(
      {
        subject: EventSubjects.INCIDENTS_RESOLVED,
        consumerName: 'resolve-worker',
        backoffMs: [1],
      },
      async (_msg, ctrl) => {
        mutations += 1;
        await ctrl.ack();
      },
    );
    await bus.publish(EventSubjects.INCIDENTS_RESOLVED, {
      payload: { incidentId: 'i-9' },
      headers: buildHeaders({ tenantId: 'acme', correlationId: 'c9' }),
      idempotencyKey: 'acme:incidents.resolved:i-9',
    });
    expect(mutations).toBe(1);
    expect(
      await store.wasProcessed('resolve-worker', 'acme:incidents.resolved:i-9'),
    ).toBe(true);
    await bus.close();
  });
});
