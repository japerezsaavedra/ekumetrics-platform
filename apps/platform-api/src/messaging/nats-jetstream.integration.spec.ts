import { InMemoryIdempotencyStore } from './idempotency';
import {
  NatsJetStreamEventBus,
  streamForSubject,
} from './nats-jetstream.event-bus';
import { EventSubjects } from './subjects';
import { buildHeaders } from './envelopes';

/**
 * Integración contra NATS JetStream real.
 *
 * Requisitos:
 *   NATS escuchando (compose: servicio nats en :4222)
 *   EVENT_BUS_INTEGRATION=1
 *   NATS_URL=nats://127.0.0.1:4222 (default)
 *
 * Ejemplo:
 *   NATS_URL=nats://127.0.0.1:4222 EVENT_BUS_INTEGRATION=1 \
 *     npm --prefix apps/platform-api test -- nats-jetstream.integration
 */
const enabled = process.env.EVENT_BUS_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;

describe('streamForSubject', () => {
  it('mapea el catálogo Wave 1 y Wave 2 a streams JetStream', () => {
    expect(streamForSubject(EventSubjects.EVENTS_INGESTED)).toBe('EKU_EVENTS');
    expect(streamForSubject(EventSubjects.TOPOLOGY_UPDATED)).toBe(
      'EKU_TOPOLOGY',
    );
    expect(streamForSubject(EventSubjects.ANOMALIES_DETECTED)).toBe(
      'EKU_ANOMALIES',
    );
    expect(streamForSubject(EventSubjects.INCIDENTS_CREATED)).toBe(
      'EKU_INCIDENTS',
    );
    expect(
      streamForSubject(EventSubjects.INCIDENTS_ENRICHMENT_REQUESTED),
    ).toBe('EKU_INCIDENTS');
    expect(streamForSubject(EventSubjects.INCIDENTS_ENRICHED)).toBe(
      'EKU_INCIDENTS',
    );
    expect(streamForSubject(EventSubjects.RCA_REQUESTED)).toBe('EKU_RCA');
    expect(streamForSubject(EventSubjects.AIOPS_INVESTIGATION_REQUESTED)).toBe(
      'EKU_AIOPS',
    );
    expect(streamForSubject(EventSubjects.ANOMALIES_DETECTED)).toBe(
      'EKU_ANOMALIES',
    );
  });
});

describeIntegration('NatsJetStreamEventBus integration', () => {
  let bus: NatsJetStreamEventBus;

  beforeAll(async () => {
    bus = new NatsJetStreamEventBus({
      url: process.env.NATS_URL ?? 'nats://127.0.0.1:4222',
      connectTimeoutMs: 3_000,
      store: new InMemoryIdempotencyStore(),
    });
    await bus.connect();
  });

  afterAll(async () => {
    await bus.close();
  });

  it('publica, consume con ack explícito y detecta Msg-Id duplicado', async () => {
    const received: string[] = [];
    const subject = EventSubjects.EVENTS_INGESTED;
    const key = `itest:${Date.now()}:${Math.random()}`;
    await bus.subscribe(
      {
        subject,
        consumerName: `itest_${Date.now()}`,
        maxDeliveries: 3,
        backoffMs: [250],
        startPolicy: 'new',
      },
      async (msg, ctrl) => {
        received.push(msg.idempotencyKey);
        await ctrl.ack();
      },
    );
    const outbound = {
      payload: { source: 'integration' },
      headers: buildHeaders({
        tenantId: 'acme',
        correlationId: 'itest-corr',
      }),
      idempotencyKey: key,
    };
    const first = await bus.publish(subject, outbound);
    const second = await bus.publish(subject, outbound);
    expect(first.duplicate).toBeFalsy();
    expect(second.duplicate).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(received).toEqual([key]);
  });
});
