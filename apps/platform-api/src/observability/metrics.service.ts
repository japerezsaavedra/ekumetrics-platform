import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

type Counter = {
  method: string;
  route: string;
  statusCode: string;
  count: number;
  sum: number;
  buckets: number[];
};

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, Counter>();
  private retentionDeleted = 0;
  private retentionFailures = 0;
  private retentionLastSuccess?: number;

  constructor(private readonly prisma: PrismaService) {}

  observe(method: string, route: string, statusCode: number, seconds: number) {
    const normalizedMethod = method.toUpperCase().slice(0, 12);
    const normalizedRoute = route || 'unknown';
    const normalizedStatus = String(statusCode);
    const key = `${normalizedMethod}\u0000${normalizedRoute}\u0000${normalizedStatus}`;
    const counter = this.counters.get(key) ?? {
      method: normalizedMethod,
      route: normalizedRoute,
      statusCode: normalizedStatus,
      count: 0,
      sum: 0,
      buckets: LATENCY_BUCKETS.map(() => 0),
    };
    counter.count += 1;
    counter.sum += Math.max(0, seconds);
    LATENCY_BUCKETS.forEach((bucket, index) => {
      if (seconds <= bucket) counter.buckets[index] += 1;
    });
    this.counters.set(key, counter);
  }

  recordRetentionSuccess(deleted: number) {
    this.retentionDeleted += deleted;
    this.retentionLastSuccess = Date.now() / 1000;
  }

  recordRetentionFailure() {
    this.retentionFailures += 1;
  }

  async render() {
    const now = Date.now();
    const fiveMinutesAgo = new Date(now - 5 * 60_000);
    const fifteenMinutesAgo = new Date(now - 15 * 60_000);
    const [agentsTotal, agentsFresh5m, agentsFresh15m, lastEvent] =
      await Promise.all([
        this.prisma.agent.count(),
        this.prisma.agent.count({
          where: { lastSeenAt: { gte: fiveMinutesAgo } },
        }),
        this.prisma.agent.count({
          where: { lastSeenAt: { gte: fifteenMinutesAgo } },
        }),
        this.prisma.agentEvent.findFirst({
          orderBy: { receivedAt: 'desc' },
          select: { receivedAt: true },
        }),
      ]);
    const lines = [
      '# HELP ekumetrics_http_requests_total Total de solicitudes HTTP atendidas por la API.',
      '# TYPE ekumetrics_http_requests_total counter',
    ];
    for (const counter of this.counters.values()) {
      const labels = this.labels(counter);
      lines.push(`ekumetrics_http_requests_total{${labels}} ${counter.count}`);
    }
    lines.push(
      '# HELP ekumetrics_http_request_duration_seconds Duración de solicitudes HTTP.',
      '# TYPE ekumetrics_http_request_duration_seconds histogram',
    );
    for (const counter of this.counters.values()) {
      const labels = this.labels(counter);
      LATENCY_BUCKETS.forEach((bucket, index) => {
        lines.push(
          `ekumetrics_http_request_duration_seconds_bucket{${labels},le="${bucket}"} ${counter.buckets[index]}`,
        );
      });
      lines.push(
        `ekumetrics_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${counter.count}`,
        `ekumetrics_http_request_duration_seconds_sum{${labels}} ${counter.sum}`,
        `ekumetrics_http_request_duration_seconds_count{${labels}} ${counter.count}`,
      );
    }
    lines.push(
      '# HELP ekumetrics_agents_total Agentes registrados.',
      '# TYPE ekumetrics_agents_total gauge',
      `ekumetrics_agents_total ${agentsTotal}`,
      '# HELP ekumetrics_agents_fresh Agentes con heartbeat dentro del umbral.',
      '# TYPE ekumetrics_agents_fresh gauge',
      `ekumetrics_agents_fresh{window="5m"} ${agentsFresh5m}`,
      `ekumetrics_agents_fresh{window="15m"} ${agentsFresh15m}`,
    );
    if (lastEvent) {
      lines.push(
        '# HELP ekumetrics_last_ingest_age_seconds Segundos desde el último evento persistido.',
        '# TYPE ekumetrics_last_ingest_age_seconds gauge',
        `ekumetrics_last_ingest_age_seconds ${Math.max(0, (now - lastEvent.receivedAt.getTime()) / 1000)}`,
      );
    }
    lines.push(
      '# HELP ekumetrics_event_retention_deleted_total Eventos eliminados por la política de retención.',
      '# TYPE ekumetrics_event_retention_deleted_total counter',
      `ekumetrics_event_retention_deleted_total ${this.retentionDeleted}`,
      '# HELP ekumetrics_event_retention_failures_total Fallos del proceso de retención.',
      '# TYPE ekumetrics_event_retention_failures_total counter',
      `ekumetrics_event_retention_failures_total ${this.retentionFailures}`,
    );
    if (this.retentionLastSuccess) {
      lines.push(
        '# HELP ekumetrics_event_retention_last_success_timestamp_seconds Última ejecución correcta de retención.',
        '# TYPE ekumetrics_event_retention_last_success_timestamp_seconds gauge',
        `ekumetrics_event_retention_last_success_timestamp_seconds ${this.retentionLastSuccess}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }

  private labels(counter: Counter) {
    return `method="${this.escape(counter.method)}",route="${this.escape(counter.route)}",status_code="${this.escape(counter.statusCode)}"`;
  }

  private escape(value: string) {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/"/g, '\\"');
  }
}
