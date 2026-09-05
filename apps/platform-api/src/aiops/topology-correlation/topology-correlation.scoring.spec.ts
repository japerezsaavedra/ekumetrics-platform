import { DEFAULT_CORRELATION_WEIGHTS } from '../correlation-weights';
import type { ClusterCorrelation } from '../correlation-types';
import {
  loadRootCauseSuppressionConfig,
  loadTopologyCorrelationConfig,
} from './topology-correlation.config';
import {
  applyTopologyComponent,
  buildBlastRadius,
  isApplicationKind,
  isInfraKind,
  isServiceKind,
  pickRootCauseKey,
  propagateImpact,
  scoreAlertPairTopology,
  scoreDependencyPath,
  scoreUpstreamCause,
  shouldSuppressIndependentIncidents,
  toBlastNode,
} from './topology-correlation.scoring';

describe('topology-correlation.scoring', () => {
  it('puntúa más un camino aguas arriba cercano que uno lejano o solo no dirigido', () => {
    const upstream = scoreDependencyPath({
      fromKey: 'app-checkout',
      toKey: 'api-checkout',
      distance: 1,
      direction: 'upstream',
      hops: 4,
      relationshipConfidence: 0.9,
    });
    const far = scoreDependencyPath({
      fromKey: 'app-checkout',
      toKey: 'sw-03',
      distance: 4,
      direction: 'undirected',
      hops: 4,
      relationshipConfidence: 0.5,
    });
    const none = scoreDependencyPath({
      fromKey: 'printer-01',
      toKey: 'ups-02',
      distance: null,
      direction: 'none',
      hops: 4,
      relationshipConfidence: 1,
    });
    expect(upstream.causalScore).toBeGreaterThan(0.8);
    expect(upstream.topologyScore).toBeGreaterThan(far.topologyScore);
    expect(none.topologyScore).toBe(0);
    expect(none.causalScore).toBe(0);
  });

  it('no asigna score causal alto a alertas cercanas en el tiempo sin topología', () => {
    const pair = scoreDependencyPath({
      fromKey: 'printer-01',
      toKey: 'ups-02',
      distance: null,
      direction: 'none',
      hops: 4,
      relationshipConfidence: 1,
    });
    const totals = scoreAlertPairTopology([pair]);
    expect(totals.topologyScore).toBe(0);
    expect(totals.causalScore).toBe(0);
    expect(totals.causalScore).toBeLessThan(0.3);
  });

  it('agrega scores de pares y de causa aguas arriba', () => {
    const a = scoreDependencyPath({
      fromKey: 'api-checkout',
      toKey: 'srv-01',
      distance: 2,
      direction: 'upstream',
      hops: 4,
      relationshipConfidence: 0.8,
    });
    const b = scoreDependencyPath({
      fromKey: 'app-checkout',
      toKey: 'srv-01',
      distance: 3,
      direction: 'upstream',
      hops: 4,
      relationshipConfidence: 0.8,
    });
    expect(scoreUpstreamCause([a, b])).toBeGreaterThan(0.4);
    expect(scoreAlertPairTopology([a, b]).topologyScore).toBeGreaterThan(0.3);
  });

  it('construye blast radius estructurado (directos, indirectos, services, apps)', () => {
    const direct = [
      toBlastNode(
        { entityKey: 'srv-01', kind: 'host', name: 'Server SRV-01' },
        1,
      ),
    ];
    const indirect = [
      toBlastNode(
        { entityKey: 'k8s-node-a', kind: 'node', name: 'K8s node A' },
        2,
      ),
      toBlastNode(
        { entityKey: 'api-checkout', kind: 'service', name: 'API checkout' },
        3,
      ),
      toBlastNode(
        {
          entityKey: 'app-checkout',
          kind: 'application',
          name: 'App checkout',
        },
        4,
      ),
    ];
    const blast = buildBlastRadius({
      originKey: 'sw-03',
      hops: 4,
      direct,
      indirect,
    });
    expect(blast.directDependents.map((node) => node.entityKey)).toEqual([
      'srv-01',
    ]);
    expect(blast.indirectDependents.map((node) => node.entityKey)).toEqual([
      'k8s-node-a',
      'api-checkout',
      'app-checkout',
    ]);
    expect(blast.affectedServices.map((node) => node.entityKey)).toEqual([
      'api-checkout',
    ]);
    expect(blast.affectedApplications.map((node) => node.entityKey)).toEqual([
      'app-checkout',
    ]);
    expect(isServiceKind('service')).toBe(true);
    expect(isApplicationKind('application')).toBe(true);
    expect(isInfraKind('switch')).toBe(true);
  });

  it('propaga impacto con decaimiento por distancia', () => {
    const blast = buildBlastRadius({
      originKey: 'sw-03',
      hops: 4,
      direct: [
        toBlastNode(
          { entityKey: 'srv-01', kind: 'host', name: 'Server SRV-01' },
          1,
        ),
      ],
      indirect: [
        toBlastNode(
          { entityKey: 'api-checkout', kind: 'service', name: 'API checkout' },
          3,
        ),
      ],
    });
    const impact = propagateImpact('sw-03', [
      ...blast.directDependents,
      ...blast.indirectDependents,
    ], 0.8);
    const direct = impact.nodes.find((node) => node.entityKey === 'srv-01');
    const far = impact.nodes.find((node) => node.entityKey === 'api-checkout');
    expect(direct?.score).toBeGreaterThan(far?.score ?? 0);
    expect(direct?.score).toBe(0.8);
  });

  it('supresión configurable: exige ancestro, confianza y distancia', () => {
    const config = loadRootCauseSuppressionConfig(() => undefined);
    expect(config.enabled).toBe(true);
    expect(
      shouldSuppressIndependentIncidents({
        config,
        nodeKeys: ['srv-01', 'api-checkout', 'app-checkout', 'k8s-node-a'],
        ancestorKey: 'sw-03',
        relationshipConfidence: 0.8,
        maxDistance: 4,
      }),
    ).toBe(true);
    expect(
      shouldSuppressIndependentIncidents({
        config: { ...config, enabled: false },
        nodeKeys: ['srv-01', 'api-checkout'],
        ancestorKey: 'sw-03',
        relationshipConfidence: 0.8,
        maxDistance: 1,
      }),
    ).toBe(false);
    expect(
      shouldSuppressIndependentIncidents({
        config,
        nodeKeys: ['printer-01', 'ups-02'],
        ancestorKey: null,
        relationshipConfidence: 1,
        maxDistance: 1,
      }),
    ).toBe(false);
    expect(
      shouldSuppressIndependentIncidents({
        config,
        nodeKeys: ['srv-01', 'api-checkout'],
        ancestorKey: 'sw-03',
        relationshipConfidence: 0.1,
        maxDistance: 1,
      }),
    ).toBe(false);
  });

  it('prefiere el switch que cubre el cluster como causa raíz', () => {
    expect(
      pickRootCauseKey({
        ancestorKey: 'srv-01',
        coveringInfraKeys: ['sw-03'],
      }),
    ).toBe('sw-03');
    expect(
      pickRootCauseKey({ ancestorKey: 'srv-01', coveringInfraKeys: [] }),
    ).toBe('srv-01');
  });

  it('recalcula el componente topológico del score V2 sin borrar evidencia previa', () => {
    const correlation: ClusterCorrelation = {
      score: 0.5,
      components: {
        temporalScore: 1,
        entityScore: 0,
        topologyScore: 0.8,
        labelScore: 0,
        historicalScore: 0,
      },
      weights: DEFAULT_CORRELATION_WEIGHTS,
      evidence: ['previa'],
      details: [
        {
          kind: 'temporal',
          statement: 'previa',
          score: 1,
        },
      ],
    };
    const next = applyTopologyComponent(correlation, 0, [
      {
        kind: 'topology_path',
        statement: 'sin camino topológico',
        score: 0,
      },
    ]);
    expect(next.components.topologyScore).toBe(0);
    expect(next.score).toBe(DEFAULT_CORRELATION_WEIGHTS.temporal);
    expect(next.evidence).toEqual(
      expect.arrayContaining(['previa', 'sin camino topológico']),
    );
  });

  it('lee hops de blast y flags de supresión desde env', () => {
    const loaded = loadTopologyCorrelationConfig((key) => {
      if (key === 'AIOPS_ROOT_CAUSE_SUPPRESSION_ENABLED') return 'false';
      if (key === 'AIOPS_ROOT_CAUSE_SUPPRESSION_MIN_CONFIDENCE') return '0.7';
      if (key === 'AIOPS_ROOT_CAUSE_SUPPRESSION_MAX_HOPS') return '3';
      if (key === 'AIOPS_TOPOLOGY_CORRELATION_HOPS') return '6';
      return undefined;
    });
    expect(loaded.suppression.enabled).toBe(false);
    expect(loaded.suppression.minConfidence).toBe(0.7);
    expect(loaded.suppression.maxHops).toBe(3);
    expect(loaded.blastHops).toBe(6);
  });
});
