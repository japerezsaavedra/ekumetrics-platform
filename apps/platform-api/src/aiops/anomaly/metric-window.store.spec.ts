import { MetricWindowStore } from './metric-window.store';

describe('MetricWindowStore aislamiento tenant', () => {
  it('no mezcla series de tenants distintos con el mismo entityId', () => {
    const store = new MetricWindowStore();
    const now = Date.parse('2026-09-05T12:00:00.000Z');
    store.append({
      tenantId: 'tenant-a',
      entityId: 'shared',
      metricName: 'cpu',
      value: 99,
      timestamp: now,
    });
    store.append({
      tenantId: 'tenant-b',
      entityId: 'shared',
      metricName: 'cpu',
      value: 1,
      timestamp: now,
    });

    const windowA = store.getWindow('tenant-a', 'shared', 'cpu', '5m', now);
    const windowB = store.getWindow('tenant-b', 'shared', 'cpu', '5m', now);
    expect(windowA).toEqual([{ timestamp: now, value: 99 }]);
    expect(windowB).toEqual([{ timestamp: now, value: 1 }]);
    expect(store.takeDirty('tenant-b').every((item) => item.tenantId === 'tenant-b')).toBe(
      true,
    );
    expect(store.takeDirty('tenant-a').every((item) => item.tenantId === 'tenant-a')).toBe(
      true,
    );
  });
});
