import { areaOption, formatPercent, formatRate, formatUptime } from '../home/dashboard-format';
import type { BoardHost, BoardView, BoardWidget } from './board-catalog';

export function boardHostOf(widget: BoardWidget, hosts: BoardHost[]): BoardHost | null {
  return hosts.find((item) => item.id === widget.agentId) ?? hosts[0] ?? null;
}

export function boardValueOf(widget: BoardWidget, host: BoardHost | null): string {
  if (!host) return '—';
  if (widget.type === 'kpi-cpu') return formatPercent(host.cpuUsed);
  if (widget.type === 'kpi-memory') return formatPercent(host.memoryUsed);
  if (widget.type === 'kpi-disk') return formatPercent(host.diskUsed ?? null);
  if (widget.type === 'kpi-uptime') return formatUptime(host.uptimeSeconds);
  if (widget.type === 'status-agent') return host.online ? 'Activo' : 'Sin señal';
  return '—';
}

export function boardNicOf(widget: BoardWidget, host: BoardHost | null, nics: BoardView['nics']) {
  return nics.find((item) => item.hostId === host?.id) ?? nics[0] ?? null;
}

export function boardChartOf(widget: BoardWidget, host: BoardHost | null, series: BoardView['series']) {
  const points = (host && series[host.id]) || Object.values(series)[0];
  if (!points) return null;
  if (widget.type === 'chart-cpu') {
    return areaOption([{ name: 'CPU', points: points.cpu }], 'percent');
  }
  if (widget.type === 'chart-network') {
    return areaOption(
      [
        { name: 'Bajada', points: points.networkRx },
        { name: 'Subida', points: points.networkTx },
      ],
      'bytesRate',
    );
  }
  return null;
}

export function boardRateOf(value: number | null | undefined): string {
  return formatRate(value ?? null);
}
