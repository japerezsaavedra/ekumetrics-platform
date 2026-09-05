import {
  ancestorDistances,
  matchesRole,
  pickClosest,
  relatedWithinHops,
  shortestPath,
  walkDirected,
} from './topology-walk';
import { TOPOLOGY_RELATIONS, isTopologyRelation } from './topology.relations';

const { CONNECTS_TO, DEPENDS_ON, HOSTS, RUNS_ON } = TOPOLOGY_RELATIONS;

const cmdb = [
  { fromKey: 'pod-a', toKey: 'host-1', relation: RUNS_ON },
  { fromKey: 'svc-api', toKey: 'host-1', relation: RUNS_ON },
  { fromKey: 'svc-api', toKey: 'svc-db', relation: DEPENDS_ON },
  { fromKey: 'svc-db', toKey: 'host-2', relation: RUNS_ON },
  { fromKey: 'host-1', toKey: 'pod-b', relation: HOSTS },
];

const lldp = [
  { fromKey: 'sw-core', toKey: 'app-01', relation: CONNECTS_TO },
  { fromKey: 'sw-core', toKey: 'app-02', relation: CONNECTS_TO },
  { fromKey: 'sw-core', toKey: 'db-01', relation: CONNECTS_TO },
  { fromKey: 'app-01', toKey: 'api-pagos', relation: CONNECTS_TO },
  { fromKey: 'app-02', toKey: 'sap', relation: CONNECTS_TO },
  { fromKey: 'db-01', toKey: 'postgres', relation: CONNECTS_TO },
];

describe('topology-walk', () => {
  it('expone el catálogo de relaciones como constantes tipadas', () => {
    expect(isTopologyRelation(TOPOLOGY_RELATIONS.CONNECTS_TO)).toBe(true);
    expect(isTopologyRelation(TOPOLOGY_RELATIONS.RUNS_ON)).toBe(true);
    expect(isTopologyRelation('UNKNOWN')).toBe(false);
  });
  it('trata DEPENDS_ON y RUNS_ON como dependencias salientes', () => {
    expect(matchesRole('svc-api', cmdb[2], 'dependencies')).toBe(true);
    expect(walkDirected('svc-api', cmdb, 2, 'dependencies')).toEqual(
      expect.arrayContaining(['svc-db', 'host-1', 'host-2']),
    );
  });

  it('encuentra dependientes por arista inversa y por HOSTS', () => {
    expect(walkDirected('host-1', cmdb, 1, 'dependents')).toEqual(
      expect.arrayContaining(['pod-a', 'svc-api', 'pod-b']),
    );
    expect(walkDirected('svc-db', cmdb, 1, 'dependents')).toEqual(['svc-api']);
  });

  it('recorre CONNECTS_TO sin dirección (compatibilidad LLDP)', () => {
    expect(shortestPath('api-pagos', 'postgres', lldp, 4)).toEqual([
      'api-pagos',
      'app-01',
      'sw-core',
      'db-01',
      'postgres',
    ]);
    const related = relatedWithinHops('sw-core', lldp, 1);
    expect(related.map((item) => item.key).sort()).toEqual([
      'app-01',
      'app-02',
      'db-01',
    ]);
  });

  it('elige el ancestro dirigido más cercano', () => {
    const keys = ['pod-a', 'svc-api'];
    const distances = keys.map((key) => ancestorDistances(key, cmdb, 4));
    const candidates = [...distances[0].keys()].filter((key) =>
      distances.every((map) => map.has(key)),
    );
    expect(pickClosest(candidates, distances)).toBe('host-1');
  });
});
