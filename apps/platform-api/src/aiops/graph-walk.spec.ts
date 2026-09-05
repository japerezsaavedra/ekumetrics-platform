import { GRAPH_EXAMPLE_EDGES as edges } from './graph-example';
import { commonCover, sharePath, walk } from './graph-walk';

describe('graph-walk', () => {
  it('alcanza el impacto de un switch en tres hops', () => {
    const reached = walk('sw-core', edges, 2);
    expect(reached.has('api-pagos')).toBe(true);
    expect(reached.has('sap')).toBe(true);
    expect(reached.has('postgres')).toBe(true);
  });

  it('une alertas que cuelgan del mismo core', () => {
    expect(sharePath('api-pagos', 'postgres', edges, 4)).toBe(true);
  });

  it('elige el elemento común de varias alertas', () => {
    expect(commonCover(['api-pagos', 'sap', 'postgres'], edges, 4)).toBe(
      'sw-core',
    );
  });

  it('no inventa un puente entre grafos distintos', () => {
    expect(
      sharePath('api-pagos', 'otro', [{ fromKey: 'x', toKey: 'y' }], 3),
    ).toBe(false);
  });
});
