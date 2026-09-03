export const BOARD_WIDGET_CATALOG = [
  { type: 'kpi-cpu', title: 'CPU', w: 3, h: 1 },
  { type: 'kpi-memory', title: 'Memoria', w: 3, h: 1 },
  { type: 'kpi-disk', title: 'Disco', w: 3, h: 1 },
  { type: 'kpi-uptime', title: 'Uptime', w: 3, h: 1 },
  { type: 'status-agent', title: 'Agente', w: 4, h: 1 },
  { type: 'chart-cpu', title: 'CPU', w: 6, h: 2 },
  { type: 'chart-network', title: 'Red', w: 6, h: 2 },
] as const;

export type BoardWidgetType = (typeof BOARD_WIDGET_CATALOG)[number]['type'];

export type BoardWidget = {
  id: string;
  type: BoardWidgetType;
  title: string;
  agentId: string;
  w: number;
  h: number;
};

export type BoardSite = {
  id: string;
  slug: string;
  name: string;
};

export type BoardRecord = {
  id: string;
  name: string;
  siteId: string | null;
  site: BoardSite | null;
  widgets: BoardWidget[];
  updatedAt: string;
};

export function boardScopeLabel(item: Pick<BoardRecord, 'site'>): string {
  return item.site?.name ?? 'Todo el tenant';
}

export type BoardHost = {
  id: string;
  siteId: string | null;
  online: boolean | null;
  cpuUsed: number | null;
  memoryUsed: number | null;
  diskUsed?: number | null;
  uptimeSeconds: number | null;
};

export type BoardView = {
  board: BoardRecord;
  hosts: BoardHost[];
  nics: Array<{
    hostId: string;
    device: string;
    rxBytesPerSec: number;
    txBytesPerSec: number;
  }>;
  series: Record<
    string,
    {
      cpu: Array<[number, number]>;
      networkRx: Array<[number, number]>;
      networkTx: Array<[number, number]>;
    }
  >;
};

export function widgetLabel(type: string): string {
  return BOARD_WIDGET_CATALOG.find((item) => item.type === type)?.title ?? type;
}
