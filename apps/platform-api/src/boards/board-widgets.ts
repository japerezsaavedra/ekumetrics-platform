export const BOARD_WIDGET_TYPES = [
  'kpi-cpu',
  'kpi-memory',
  'kpi-disk',
  'kpi-uptime',
  'status-agent',
  'chart-cpu',
  'chart-network',
] as const;

export type BoardWidgetType = (typeof BOARD_WIDGET_TYPES)[number];

export type BoardWidget = {
  id: string;
  type: BoardWidgetType;
  title: string;
  agentId: string;
  w: number;
  h: number;
};

const TYPES = new Set<string>(BOARD_WIDGET_TYPES);

export function sanitizeWidgets(input: unknown): BoardWidget[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }
      const row = item as Record<string, unknown>;
      const type = String(row.type ?? '');
      if (!TYPES.has(type)) {
        return null;
      }
      const w = Number(row.w);
      const h = Number(row.h);
      return {
        id: String(row.id ?? '').trim() || crypto.randomUUID(),
        type: type as BoardWidgetType,
        title: String(row.title ?? '').trim().slice(0, 80) || type,
        agentId: String(row.agentId ?? '').trim().slice(0, 120),
        w: [3, 4, 6, 12].includes(w) ? w : 4,
        h: h === 2 ? 2 : 1,
      };
    })
    .filter((item): item is BoardWidget => item !== null)
    .slice(0, 24);
}
