import { TenantScopeError } from '../persistence/tenant-scope.error';
import { InMemoryHistoricalRepository } from './in-memory.historical.repository';
import { hashIncidentSignature } from './signature';

describe('InMemoryHistoricalRepository persistencia y tenant', () => {
  const checkout = hashIncidentSignature({
    tenantId: 'tenant-a',
    entityTypes: ['service'],
    service: 'checkout',
    eventTypes: ['alert.received'],
    environment: 'production',
  });

  it('persiste feedback y ResolutionRecord solo en el tenant indicado', async () => {
    const store = new InMemoryHistoricalRepository();
    const signature = await store.upsertSignature({
      tenantId: 'tenant-a',
      hash: checkout.hash,
      incidentId: 'inc-1',
      ...checkout.characteristics,
    });
    await store.createFeedback({
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
      action: 'CONFIRM',
      selectedEntityId: 'postgres.prod',
      note: 'Pool saturado; se subió el max_connections.',
      userId: 'ops@example.com',
    });
    await store.upsertResolution({
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
      signatureId: signature.id,
      confirmedRootCause: 'postgres.prod',
      successfulAction: 'scale_pool',
      timeToDetectMs: 12_000,
      timeToResolveMs: 300_000,
    });

    const feedbackA = await store.listFeedback('tenant-a', 'inc-1');
    const resolutionA = await store.findResolutionByIncident(
      'tenant-a',
      'inc-1',
    );
    expect(feedbackA).toHaveLength(1);
    expect(feedbackA[0]?.action).toBe('CONFIRM');
    expect(resolutionA?.confirmedRootCause).toBe('postgres.prod');
    expect(resolutionA?.successfulAction).toBe('scale_pool');

    expect(await store.listFeedback('tenant-b', 'inc-1')).toEqual([]);
    expect(
      await store.findResolutionByIncident('tenant-b', 'inc-1'),
    ).toBeNull();
    expect(await store.listSignatures('tenant-b')).toEqual([]);
    expect(await store.findSignatureByHash('tenant-b', checkout.hash)).toBeNull();
  });

  it('rechaza operaciones sin tenantId', async () => {
    const store = new InMemoryHistoricalRepository();
    await expect(
      store.listSignatures(''),
    ).rejects.toBeInstanceOf(TenantScopeError);
    await expect(
      store.createFeedback({
        tenantId: '',
        incidentId: 'inc-1',
        action: 'ADD_NOTE',
        note: 'x',
      }),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('SELECT_ALTERNATIVE vía upsert mueve la causa previa a rechazadas', async () => {
    const store = new InMemoryHistoricalRepository();
    await store.upsertResolution({
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
      confirmedRootCause: 'api',
    });
    const next = await store.upsertResolution({
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
      confirmedRootCause: 'postgres',
      appendRejected: ['api'],
    });
    expect(next.confirmedRootCause).toBe('postgres');
    expect(next.rejectedRootCauses).toContain('api');
  });
});
