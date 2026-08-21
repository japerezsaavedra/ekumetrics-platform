const STORAGE_RANGE = 'eku-dashboard-range';
const STORAGE_REFRESH = 'eku-dashboard-refresh';

export const DASHBOARD_RANGES = [
  { id: '15m', label: 'Ultimos 15 min', seconds: 900 },
  { id: '1h', label: 'Ultima hora', seconds: 3600 },
  { id: '3h', label: 'Ultimas 3 h', seconds: 10800 },
  { id: '6h', label: 'Ultimas 6 h', seconds: 21600 },
  { id: '12h', label: 'Ultimas 12 h', seconds: 43200 },
  { id: '24h', label: 'Ultimas 24 h', seconds: 86400 },
  { id: '7d', label: 'Ultimos 7 dias', seconds: 604800 },
] as const;

export const DASHBOARD_REFRESHES = [
  { id: 'off', label: 'Off', ms: 0 },
  { id: '5s', label: '5s', ms: 5000 },
  { id: '10s', label: '10s', ms: 10_000 },
  { id: '30s', label: '30s', ms: 30_000 },
  { id: '1m', label: '1m', ms: 60_000 },
  { id: '5m', label: '5m', ms: 300_000 },
] as const;

export type DashboardRangeId = (typeof DASHBOARD_RANGES)[number]['id'];
export type DashboardRefreshId = (typeof DASHBOARD_REFRESHES)[number]['id'];

export function readRange(): DashboardRangeId {
  return pickId(localStorage.getItem(STORAGE_RANGE), DASHBOARD_RANGES, '15m');
}

export function readRefresh(): DashboardRefreshId {
  return pickId(localStorage.getItem(STORAGE_REFRESH), DASHBOARD_REFRESHES, '10s');
}

export function persistTime(range: string, refresh: string): void {
  localStorage.setItem(STORAGE_RANGE, range);
  localStorage.setItem(STORAGE_REFRESH, refresh);
}

export function rangeSeconds(id: string): number {
  return DASHBOARD_RANGES.find((item) => item.id === id)?.seconds ?? 900;
}

export function refreshMs(id: string): number {
  return DASHBOARD_REFRESHES.find((item) => item.id === id)?.ms ?? 10_000;
}

export function rangeLabel(id: string): string {
  return DASHBOARD_RANGES.find((item) => item.id === id)?.label ?? id;
}

function pickId<T extends { id: string }>(
  value: string | null,
  catalog: readonly T[],
  fallback: T['id'],
): T['id'] {
  return catalog.some((item) => item.id === value) ? (value as T['id']) : fallback;
}
