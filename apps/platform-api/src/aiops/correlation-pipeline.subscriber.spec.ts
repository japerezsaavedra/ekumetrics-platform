import { InMemoryEventBus } from '../messaging/in-memory.event-bus';
import { InMemoryIdempotencyStore } from '../messaging/idempotency';
import { EventSubjects } from '../messaging/subjects';
import { buildHeaders } from '../messaging/envelopes';
import { DeferredCorrelationPipelineConsumer } from './correlation-pipeline.port';
import { CorrelationPipelineSubscriber } from './correlation-pipeline.subscriber';

describe('CorrelationPipelineSubscriber', () => {
  it('reenvía anomalies.detected al consumer sin correlacionar', async () => {
    const bus = new InMemoryEventBus(new InMemoryIdempotencyStore());
    const consumer = {
      onSignal: jest.fn().mockResolvedValue(undefined),
    };
    const subscriber = new CorrelationPipelineSubscriber(bus, consumer);
    await subscriber.onModuleInit();
    await bus.publish(EventSubjects.ANOMALIES_DETECTED, {
      payload: { tenantId: 'tenant-a', entityId: 'postgres.prod' },
      headers: buildHeaders({
        tenantId: 'tenant-a',
        correlationId: 'c1',
        producedBy: 'test',
      }),
      idempotencyKey: 'tenant-a:anomalies.detected:1',
    });
    expect(consumer.onSignal).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      reason: 'anomalies.detected',
      entityIds: ['postgres.prod'],
    });
    await subscriber.onModuleDestroy();
    await bus.close();
  });

  it('DeferredCorrelationPipelineConsumer no crea incidentes', async () => {
    await expect(
      new DeferredCorrelationPipelineConsumer().onSignal({
        tenantId: 'tenant-a',
        reason: 'anomalies.detected',
      }),
    ).resolves.toBeUndefined();
  });
});
