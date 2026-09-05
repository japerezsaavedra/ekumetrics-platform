import {
  DEFAULT_CORRELATION_WEIGHTS,
  loadCorrelationHops,
  loadCorrelationWeights,
  loadCorrelationWindowMs,
  normalizeCorrelationWeights,
} from './correlation-weights';

describe('correlation-weights', () => {
  it('usa los valores por defecto si no hay override', () => {
    const weights = loadCorrelationWeights(() => undefined);
    expect(weights.temporal).toBeCloseTo(DEFAULT_CORRELATION_WEIGHTS.temporal);
    expect(weights.entity).toBeCloseTo(DEFAULT_CORRELATION_WEIGHTS.entity);
    expect(weights.topology).toBeCloseTo(DEFAULT_CORRELATION_WEIGHTS.topology);
    expect(weights.label).toBeCloseTo(DEFAULT_CORRELATION_WEIGHTS.label);
    expect(weights.historical).toBeCloseTo(
      DEFAULT_CORRELATION_WEIGHTS.historical,
    );
  });

  it('permite override por env y normaliza a 1', () => {
    const weights = loadCorrelationWeights((key) =>
      key === 'AIOPS_CORRELATION_WEIGHT_TEMPORAL' ? '2' : '1',
    );
    const sum =
      weights.temporal +
      weights.entity +
      weights.topology +
      weights.label +
      weights.historical;
    expect(sum).toBeCloseTo(1);
    expect(weights.temporal).toBeCloseTo(2 / 6);
  });

  it('ignora valores inválidos y cae al default', () => {
    const weights = loadCorrelationWeights((key) =>
      key === 'AIOPS_CORRELATION_WEIGHT_ENTITY' ? 'no-numero' : undefined,
    );
    expect(weights.entity).toBeCloseTo(DEFAULT_CORRELATION_WEIGHTS.entity);
  });

  it('normaliza pesos todos-cero al default', () => {
    const weights = normalizeCorrelationWeights({
      temporal: 0,
      entity: 0,
      topology: 0,
      label: 0,
      historical: 0,
    });
    expect(weights).toEqual(DEFAULT_CORRELATION_WEIGHTS);
  });

  it('lee ventana y hops configurables con default compatible', () => {
    expect(loadCorrelationWindowMs(() => undefined)).toBe(5 * 60_000);
    expect(loadCorrelationHops(() => undefined)).toBe(4);
    expect(
      loadCorrelationWindowMs((key) =>
        key === 'AIOPS_CORRELATION_WINDOW_MS' ? '120000' : undefined,
      ),
    ).toBe(120000);
    expect(
      loadCorrelationHops((key) =>
        key === 'AIOPS_CORRELATION_HOPS' ? '2' : undefined,
      ),
    ).toBe(2);
  });
});
