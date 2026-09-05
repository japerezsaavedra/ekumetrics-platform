import { InMemoryIdempotencyStore } from '../../messaging/idempotency';
import { InMemoryEventBus } from '../../messaging/in-memory.event-bus';
import { EventSubjects } from '../../messaging/subjects';
import { buildHeaders } from '../../messaging/envelopes';
import { createRcaEvidence } from '../types/rca-evidence';
import { createRootCauseCandidate } from '../types/root-cause-candidate';
import { RCA_ALGORITHM } from './constants';
import { RcaEventSubscriber } from './subscriber';
import type { RcaEngine } from '../interfaces/rca-engine';
import type { RcaCompletedPayload, RcaRequestedPayload } from './types';

describe('RcaEventSubscriber', () => {
  it('consume rca.requested y publica rca.completed con tenantId', async () => {
    const store = new InMemoryIdempotencyStore();
    const bus = new InMemoryEventBus(store);
    const seenTenants: string[] = [];
    const engine: RcaEngine = {
      propose: (input) => {
        seenTenants.push(input.tenantId);
        return Promise.resolve([
          createRootCauseCandidate({
            tenantId: input.tenantId,
            incidentId: input.incidentId,
            rank: 1,
            entityKey: 'postgres',
            entityType: 'database',
            hypothesis:
              'PostgreSQL PROD es el candidato principal de causa raíz porque: anomalía de latency score 0.94. Score 0.88, confianza 0.91, algoritmo weighted_subscores_v1.',
            score: 0.88,
            confidence: 0.91,
            evidence: [
              createRcaEvidence({
                kind: 'metric',
                summary: 'anomalía de latency score 0.94',
                confidence: 0.94,
                entityKey: 'postgres',
                facts: { algorithm: RCA_ALGORITHM, score: 0.94 },
              }),
            ],
            source: 'deterministic_rca',
            algorithm: RCA_ALGORITHM,
            findingIds: [],
            affectedEntities: ['api', 'frontend'],
            affectedServices: ['api'],
            subscores: {
              temporalScore: 0.8,
              topologyScore: 0.9,
              anomalyScore: 0.94,
              dependencyScore: 0.85,
              historicalScore: 0.5,
            },
            weights: {
              temporal: 0.2,
              topology: 0.25,
              anomaly: 0.2,
              dependency: 0.25,
              historical: 0.1,
            },
          }),
        ]);
      },
    };
    const completed: RcaCompletedPayload[] = [];
    await bus.subscribe<RcaCompletedPayload>(
      {
        subject: EventSubjects.RCA_COMPLETED,
        consumerName: 'test-rca-completed',
      },
      async (msg, ctrl) => {
        completed.push(msg.payload);
        await ctrl.ack();
      },
    );
    const subscriber = new RcaEventSubscriber(bus, engine);
    await subscriber.onModuleInit();

    const payload: RcaRequestedPayload = {
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
    };
    await bus.publish(EventSubjects.RCA_REQUESTED, {
      payload,
      headers: buildHeaders({
        tenantId: 'tenant-a',
        incidentId: 'inc-1',
        correlationId: 'corr-rca-1',
        producedBy: 'test',
      }),
      idempotencyKey: 'tenant-a:rca.requested:inc-1',
    });

    expect(seenTenants).toEqual(['tenant-a']);
    expect(completed).toHaveLength(1);
    expect(completed[0].tenantId).toBe('tenant-a');
    expect(completed[0].incidentId).toBe('inc-1');
    expect(completed[0].algorithm).toBe(RCA_ALGORITHM);
    expect(completed[0].candidateCount).toBe(1);
    expect(completed[0].primaryEntityId).toBe('postgres');
    expect(completed[0].rcaConfidence).toBe(0.91);
    expect(completed[0].candidates[0].entityId).toBe('postgres');
    expect(completed[0].candidates[0].score).toBe(0.88);
    expect(completed[0].candidates[0].confidence).toBe(0.91);
    expect(completed[0].candidates[0].evidence[0].summary).toMatch(/latency/);

    await subscriber.onModuleDestroy();
    await bus.close();
  });

  it('no procesa rca.requested de otro tenant (mismatch header/payload)', async () => {
    const store = new InMemoryIdempotencyStore();
    const bus = new InMemoryEventBus(store);
    let called = 0;
    const engine: RcaEngine = {
      propose: () => {
        called += 1;
        return Promise.resolve([]);
      },
    };
    const subscriber = new RcaEventSubscriber(bus, engine);
    await subscriber.onModuleInit();
    await bus.publish(EventSubjects.RCA_REQUESTED, {
      payload: { tenantId: 'tenant-b', incidentId: 'inc-1' },
      headers: buildHeaders({
        tenantId: 'tenant-a',
        correlationId: 'corr-x',
      }),
      idempotencyKey: 'mismatch-1',
    });
    expect(called).toBe(0);
    await subscriber.onModuleDestroy();
    await bus.close();
  });
});
