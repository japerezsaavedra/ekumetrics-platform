import {
  DEFAULT_RCA_WEIGHTS,
  loadRcaHops,
  loadRcaWeights,
  normalizeRcaWeights,
  parseRcaHopsPayload,
  parseRcaWeightsPayload,
} from './scoring-policy';

describe('RcaScoringPolicy', () => {
  it('usa defaults si no hay override', () => {
    const weights = loadRcaWeights(() => undefined);
    expect(weights).toEqual(DEFAULT_RCA_WEIGHTS);
    expect(loadRcaHops(() => undefined)).toBe(8);
  });

  it('parsea payload de Policy por tenant', () => {
    const weights = parseRcaWeightsPayload({
      weights: { temporal: 1, dependency: 3, topology: 1, anomaly: 1, historical: 0 },
    });
    expect(weights).not.toBeNull();
    expect(weights!.dependency).toBeGreaterThan(weights!.temporal);
    expect(
      weights!.temporal +
        weights!.topology +
        weights!.anomaly +
        weights!.dependency +
        weights!.historical,
    ).toBeCloseTo(1);
    expect(parseRcaHopsPayload({ hops: 4 }, 8)).toBe(4);
  });

  it('normaliza ceros al default', () => {
    expect(
      normalizeRcaWeights({
        temporal: 0,
        topology: 0,
        anomaly: 0,
        dependency: 0,
        historical: 0,
      }),
    ).toEqual(DEFAULT_RCA_WEIGHTS);
  });
});
