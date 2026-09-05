import {
  DEFAULT_PRIORITY_WEIGHTS,
  IncidentPriorityCalculator,
  SEVERITY_ONLY_WEIGHTS,
  type PriorityInput,
} from './incident-priority.calculator';

function sample(overrides: Partial<PriorityInput> = {}): PriorityInput {
  return {
    severity: 'warning',
    environment: 'prod',
    blastRadiusEntityCount: 2,
    affectedEntityCount: 2,
    serviceKinds: ['host'],
    tenantPolicy: null,
    ...overrides,
  };
}

describe('IncidentPriorityCalculator', () => {
  it('no deriva la prioridad solo de la severidad cruda (blast-radius-aware)', () => {
    const calc = new IncidentPriorityCalculator({
      weights: DEFAULT_PRIORITY_WEIGHTS,
    });
    const small = calc.calculate(
      sample({
        severity: 'critical',
        blastRadiusEntityCount: 1,
        affectedEntityCount: 1,
        serviceKinds: ['host'],
      }),
    );
    const wide = calc.calculate(
      sample({
        severity: 'critical',
        blastRadiusEntityCount: 20,
        affectedEntityCount: 16,
        serviceKinds: ['database', 'service'],
      }),
    );
    expect(wide.score).toBeGreaterThan(small.score);
    expect(wide.factors.find((item) => item.id === 'blastRadius')?.score).toBe(1);
    expect(small.factors.find((item) => item.id === 'blastRadius')?.score).toBe(
      0.1,
    );
    expect(wide.algorithm).toBe('weighted_priority_v1');
    expect(wide.evidence.length).toBeGreaterThan(0);
  });

  it('severity-only ignora radio de impacto y criticidad', () => {
    const calc = new IncidentPriorityCalculator({
      weights: SEVERITY_ONLY_WEIGHTS,
    });
    const small = calc.calculate(
      sample({
        severity: 'critical',
        blastRadiusEntityCount: 1,
        serviceKinds: ['host'],
      }),
    );
    const wide = calc.calculate(
      sample({
        severity: 'critical',
        blastRadiusEntityCount: 40,
        serviceKinds: ['database'],
      }),
    );
    expect(small.score).toBeCloseTo(wide.score, 5);
    expect(small.level).toBe('P1');
    expect(wide.level).toBe('P1');
    expect(small.factors.find((item) => item.id === 'blastRadius')?.weight).toBe(
      0,
    );
  });

  it('aplica politica de tenant (boost y piso de prioridad)', () => {
    const calc = new IncidentPriorityCalculator();
    const plain = calc.calculate(sample({ severity: 'info', environment: 'dev' }));
    const boosted = calc.calculate(
      sample({
        severity: 'info',
        environment: 'dev',
        tenantPolicy: { boost: 1, minLevel: 'P2' },
      }),
    );
    expect(boosted.score).toBeGreaterThan(plain.score);
    expect(boosted.level).toBe('P2');
  });

  it('acepta un contributor extra sin perder factores nucleares', () => {
    const calc = new IncidentPriorityCalculator().withContributor({
      id: 'tenantPolicy',
      algorithm: 'custom_policy',
      source: 'test',
      score: () => ({ score: 1, evidence: 'custom' }),
    });
    const result = calc.calculate(sample());
    expect(result.factors.some((item) => item.algorithm === 'custom_policy')).toBe(
      true,
    );
    expect(result.factors.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'severity',
        'serviceCriticality',
        'blastRadius',
        'environment',
        'affectedEntityCount',
        'tenantPolicy',
      ]),
    );
  });
});
