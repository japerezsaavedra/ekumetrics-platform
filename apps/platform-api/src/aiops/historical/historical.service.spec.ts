import { TenantScopeError } from '../persistence/tenant-scope.error';
import { HistoricalService } from './historical.service';
import { InMemoryHistoricalRepository } from './in-memory.historical.repository';
import { NeutralHistoricalEvidence } from './historical-evidence.port';
import { NEUTRAL_HISTORICAL_SCORE } from './types';
import type { IncidentSignatureInput } from './types';

function checkoutOutage(tenantId: string): IncidentSignatureInput {
  return {
    tenantId,
    entityTypes: ['database', 'service'],
    service: 'checkout',
    eventTypes: ['metric.anomaly', 'alert.received'],
    anomalyTypes: ['latency'],
    topologyPattern: 'database>service',
    environment: 'production',
  };
}

function diskOnHost(tenantId: string): IncidentSignatureInput {
  return {
    tenantId,
    entityTypes: ['host'],
    service: 'checkout',
    eventTypes: ['disk.full'],
    anomalyTypes: ['saturation'],
    topologyPattern: 'switch>host',
    environment: 'production',
  };
}

describe('HistoricalService', () => {
  const repo = () => new InMemoryHistoricalRepository();
  const service = () => new HistoricalService(repo());

  it('sin historial devuelve matches vacíos y contribución NEUTRAL (no fabrica)', async () => {
    const historical = service();
    const result = await historical.lookup(
      'tenant-a',
      checkoutOutage('tenant-a'),
    );
    expect(result.matches).toEqual([]);
    expect(result.historicalScore).toBe(NEUTRAL_HISTORICAL_SCORE);
    expect(result.confidence).toBe(0);
    expect(result.stance).toBe('NEUTRAL');
    expect(result.overridesCurrentEvidence).toBe(false);
    expect(result.evidence[0]?.summary).toMatch(/Sin historial/i);
  });

  it('NeutralHistoricalEvidence siempre es NEUTRAL', async () => {
    const port = new NeutralHistoricalEvidence();
    const result = await port.lookup('tenant-a', checkoutOutage('tenant-a'));
    expect(result.matches).toEqual([]);
    expect(result.historicalScore).toBe(NEUTRAL_HISTORICAL_SCORE);
    expect(result.overridesCurrentEvidence).toBe(false);
  });

  it('empareja incidentes similares del mismo tenant y no veta la evidencia actual', async () => {
    const historical = service();
    await historical.recordSignature(
      'tenant-a',
      checkoutOutage('tenant-a'),
      'inc-past',
    );
    await historical.recordFeedback({
      tenantId: 'tenant-a',
      incidentId: 'inc-past',
      action: 'CONFIRM',
      confirmedRootCause: 'postgres.prod',
      successfulAction: 'restart_connection_pool',
      timeToDetectMs: 34_000,
      timeToResolveMs: 420_000,
      signature: checkoutOutage('tenant-a'),
    });
    const result = await historical.lookup('tenant-a', {
      ...checkoutOutage('tenant-a'),
      incidentId: 'inc-now',
    });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.incidentId).toBe('inc-past');
    expect(result.matches[0]?.similarity).toBeGreaterThan(0.9);
    expect(result.matches[0]?.confirmedRootCause).toBe('postgres.prod');
    expect(result.historicalScore).toBeGreaterThan(NEUTRAL_HISTORICAL_SCORE);
    expect(result.stance).toBe('SUPPORTING');
    expect(result.overridesCurrentEvidence).toBe(false);
    expect(result.matches[0]?.algorithm).toBe('deterministic_jaccard_v1');
  });

  it('falso positivo: mismo servicio distinto patrón no produce similarity cerca de 1.0 ni SUPPORTING', async () => {
    const historical = service();
    await historical.recordSignature(
      'tenant-a',
      diskOnHost('tenant-a'),
      'inc-disk',
    );
    const result = await historical.lookup('tenant-a', {
      ...checkoutOutage('tenant-a'),
      incidentId: 'inc-now',
    });
    const best = result.matches[0];
    if (best) {
      expect(best.similarity).toBeLessThan(0.5);
    }
    expect(result.stance).toBe('NEUTRAL');
    expect(result.historicalScore).toBe(NEUTRAL_HISTORICAL_SCORE);
    expect(result.overridesCurrentEvidence).toBe(false);
  });

  it('no compara historial entre tenants aunque la firma sea idéntica', async () => {
    const historical = service();
    await historical.recordSignature(
      'tenant-a',
      checkoutOutage('tenant-a'),
      'inc-a',
    );
    await historical.recordFeedback({
      tenantId: 'tenant-a',
      incidentId: 'inc-a',
      action: 'CONFIRM',
      confirmedRootCause: 'postgres.prod',
      signature: checkoutOutage('tenant-a'),
    });
    const forB = await historical.lookup(
      'tenant-b',
      checkoutOutage('tenant-b'),
    );
    expect(forB.matches).toEqual([]);
    expect(forB.historicalScore).toBe(NEUTRAL_HISTORICAL_SCORE);
    expect(forB.stance).toBe('NEUTRAL');
    expect(forB.matches.some((item) => item.incidentId === 'inc-a')).toBe(
      false,
    );
  });

  it('persiste las cuatro acciones de feedback del operador', async () => {
    const historical = service();
    const signature = checkoutOutage('tenant-a');
    await historical.recordFeedback({
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
      action: 'CONFIRM',
      confirmedRootCause: 'api',
      signature,
    });
    await historical.recordFeedback({
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
      action: 'REJECT',
      selectedEntityId: 'api',
    });
    await historical.recordFeedback({
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
      action: 'SELECT_ALTERNATIVE',
      confirmedRootCause: 'postgres.prod',
    });
    await historical.recordFeedback({
      tenantId: 'tenant-a',
      incidentId: 'inc-1',
      action: 'ADD_NOTE',
      note: 'Se reciclo el pool de conexiones.',
    });
    const feedback = await historical.listFeedback('tenant-a', 'inc-1');
    expect(feedback.map((item) => item.action)).toEqual([
      'CONFIRM',
      'REJECT',
      'SELECT_ALTERNATIVE',
      'ADD_NOTE',
    ]);
    const resolution = await historical.findResolution('tenant-a', 'inc-1');
    expect(resolution?.confirmedRootCause).toBe('postgres.prod');
    expect(resolution?.rejectedRootCauses).toEqual(
      expect.arrayContaining(['api']),
    );
    expect(resolution?.resolution).toBe('Se reciclo el pool de conexiones.');
    expect(await historical.listFeedback('tenant-b', 'inc-1')).toEqual([]);
  });

  it('lookup no devuelve el incidente consultado como si fuera historial', async () => {
    const historical = service();
    await historical.recordSignature(
      'tenant-a',
      checkoutOutage('tenant-a'),
      'inc-now',
    );
    const result = await historical.lookup('tenant-a', {
      ...checkoutOutage('tenant-a'),
      incidentId: 'inc-now',
    });
    expect(result.matches).toEqual([]);
    expect(result.historicalScore).toBe(NEUTRAL_HISTORICAL_SCORE);
  });

  it('exige tenantId', async () => {
    const historical = service();
    await expect(
      historical.lookup('', checkoutOutage('tenant-a')),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });
});
