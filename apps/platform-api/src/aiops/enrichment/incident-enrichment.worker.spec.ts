jest.mock('../../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { InMemoryEventBus } from '../../messaging/in-memory.event-bus';
import { InMemoryIdempotencyStore } from '../../messaging/idempotency';
import { EventSubjects } from '../../messaging/subjects';
import { buildHeaders } from '../../messaging/envelopes';
import { IncidentEnrichmentWorker } from './incident-enrichment.worker';
import type { EnrichmentRequestedPayload } from './incident-enrichment.types';

describe('IncidentEnrichmentWorker', () => {
  it('enriquece de forma asincrona y publica ekumetrics.incidents.enriched', async () => {
    const bus = new InMemoryEventBus(new InMemoryIdempotencyStore());
    const enrichment = {
      enrich: jest.fn().mockResolvedValue({
        tenantId: 'tenant-a',
        incidentId: 'inc-1',
        algorithm: 'deterministic_enrichment_v1',
        source: 'aiops.enrichment',
        score: 0.7,
        confidence: 0.8,
        computedPriority: { level: 'P2' },
        rcaConfidence: 0.85,
      }),
    };
    const worker = new IncidentEnrichmentWorker(bus, enrichment as never);
    await worker.onModuleInit();

    const enriched: EnrichmentRequestedPayload[] = [];
    await bus.subscribe<EnrichmentRequestedPayload>(
      {
        subject: EventSubjects.INCIDENTS_ENRICHED,
        consumerName: 'test-enriched',
      },
      async (msg, ctrl) => {
        enriched.push(msg.payload);
        await ctrl.ack();
      },
    );

    await bus.publish(EventSubjects.INCIDENTS_ENRICHMENT_REQUESTED, {
      payload: { tenantId: 'tenant-a', incidentId: 'inc-1' },
      headers: buildHeaders({
        tenantId: 'tenant-a',
        incidentId: 'inc-1',
        correlationId: 'c1',
      }),
      idempotencyKey: 'tenant-a:incidents.enrichment.requested:inc-1:1',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(enrichment.enrich).toHaveBeenCalledWith('tenant-a', 'inc-1');
    expect(enriched[0]).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-a',
        incidentId: 'inc-1',
        priority: 'P2',
      }),
    );
    await worker.onModuleDestroy();
    await bus.close();
  });

  it('termina el mensaje si el tenant del header no coincide', async () => {
    const enrichment = { enrich: jest.fn() };
    const worker = new IncidentEnrichmentWorker(
      { isAvailable: () => true } as never,
      enrichment as never,
    );
    const ctrl = { term: jest.fn(), ack: jest.fn(), nak: jest.fn() };
    await worker.handle(
      {
        subject: EventSubjects.INCIDENTS_ENRICHMENT_REQUESTED,
        payload: { tenantId: 'tenant-b', incidentId: 'inc-1' },
        headers: {
          tenantId: 'tenant-a',
          correlationId: 'c1',
          contentType: 'application/json',
          schemaVersion: '1',
          producedBy: 'test',
          occurredAt: new Date().toISOString(),
        },
        idempotencyKey: 'k',
        attempt: 1,
        ackRef: '1',
      },
      ctrl as never,
    );
    expect(ctrl.term).toHaveBeenCalledWith('tenantId header/payload mismatch');
    expect(enrichment.enrich).not.toHaveBeenCalled();
  });
});
