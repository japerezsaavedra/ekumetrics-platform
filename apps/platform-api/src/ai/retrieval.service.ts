import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DashboardService } from '../dashboard/dashboard.service';
import { TelemetryClient } from '../dashboard/telemetry.client';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeService } from './knowledge.service';

export type RetrievalMetric =
  | 'cpu_used_ratio'
  | 'memory_used_ratio'
  | 'load_1m'
  | 'network_receive_bps'
  | 'network_transmit_bps'
  | 'process_cpu_seconds'
  | 'database_presence'
  | 'queue_presence'
  | 'sap_sessions'
  | 'icewarp_service_running';

export type RetrievalContext = {
  tenantSlug: string;
  actor: string;
  agentId?: string;
  siteId?: string;
};

export type RetrievalEvidence = {
  id: string;
  source:
    'prometheus' | 'loki' | 'tempo' | 'postgresql' | 'inventory' | 'knowledge';
  operation: string;
  window: { start: string; end: string };
  summary: string;
  timestamp: string;
  resultCount: number;
  available?: boolean;
  citation?: string;
  references?: Array<{
    traceId?: string;
    spanIds?: string[];
    service?: string;
    operation?: string;
    durationMs?: number;
    documentId?: string;
    sourceKey?: string;
    title?: string;
    section?: string;
    version?: string;
    approvedAt?: string;
  }>;
};

type AuthorizedContext = RetrievalContext & {
  tenantId: string;
  agentDbId?: string;
};

@Injectable()
export class RetrievalService {
  constructor(
    private readonly telemetry: TelemetryClient,
    private readonly dashboard: DashboardService,
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
  ) {}

  readonly tools = [
    'get_host_health',
    'get_metric_series',
    'find_metric_anomalies',
    'search_logs',
    'search_traces',
    'get_component_dependencies',
    'get_agent_events',
    'get_open_incidents',
    'search_knowledge',
  ] as const;

  async searchKnowledge(
    context: RetrievalContext,
    question: string,
    limit = 8,
  ) {
    const safeLimit = this.integer(limit, 1, 20, 'limit');
    const rows = await this.knowledge.search(
      context.tenantSlug,
      context.actor,
      question,
      safeLimit,
    );
    const result = this.result(
      'knowledge',
      'search_knowledge',
      0,
      rows,
      rows.length,
    );
    result.evidence[0].references = rows.map((row) => ({
      documentId: row.documentId,
      sourceKey: row.sourceKey,
      title: row.title,
      section: row.section ?? '',
      version: row.version,
      approvedAt: row.approvedAt,
    }));
    return result;
  }

  async getHostHealth(context: RetrievalContext) {
    const auth = await this.authorize(context, true);
    const selector = this.selector(auth);
    const [cpu, memory, load, uptime, modules] = await Promise.all([
      this.telemetry.instant(
        `1 - sum(rate(system_cpu_time_seconds_total${this.selector(auth, ['state="idle"'])}[5m])) / sum(rate(system_cpu_time_seconds_total${selector}[5m]))`,
      ),
      this.telemetry.instant(
        `sum(system_memory_usage_bytes${this.selector(auth, ['state="used"'])}) / sum(system_memory_usage_bytes${selector})`,
      ),
      this.telemetry.instant(`max(system_cpu_load_average_1m${selector})`),
      this.telemetry.instant(
        `max(system_uptime_seconds${selector}) or max(system_uptime${selector})`,
      ),
      this.telemetry.instant(`ekms_agent_module_enabled${selector}`),
    ]);
    const data = {
      agentId: auth.agentId,
      siteId: auth.siteId,
      cpuUsedRatio: this.telemetry.first(cpu),
      memoryUsedRatio: this.telemetry.first(memory),
      load1m: this.telemetry.first(load),
      uptimeSeconds: this.telemetry.first(uptime),
      modules: modules
        .filter((row) => row.value >= 1 && row.metric.module)
        .slice(0, 50)
        .map((row) => row.metric.module),
    };
    return this.result('prometheus', 'get_host_health', 300, data, 1);
  }

  async getMetricSeries(
    context: RetrievalContext,
    metric: RetrievalMetric,
    windowMinutes = 60,
  ) {
    const auth = await this.authorize(context, true);
    const seconds = this.windowSeconds(windowMinutes);
    const step = Math.max(10, Math.ceil(seconds / 600));
    const query = this.metricQuery(auth, metric);
    const rows = (await this.telemetry.range(query, seconds, step))
      .slice(0, 20)
      .map((row) => ({
        labels: this.safeLabels(row.metric),
        values: row.values.slice(-600),
      }));
    return this.result(
      'prometheus',
      `get_metric_series:${metric}`,
      seconds,
      rows,
      rows.reduce((total, row) => total + row.values.length, 0),
    );
  }

  async findMetricAnomalies(
    context: RetrievalContext,
    metric: RetrievalMetric,
    windowMinutes = 60,
  ) {
    const series = await this.getMetricSeries(context, metric, windowMinutes);
    const values = series.data
      .flatMap((row) => row.values.map((point) => point[1]))
      .filter(Number.isFinite);
    const mean = values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
    const deviation =
      mean === null || values.length < 2
        ? null
        : Math.sqrt(
            values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
              values.length,
          );
    const anomalies =
      mean === null || deviation === null || deviation === 0
        ? []
        : series.data.flatMap((row) =>
            row.values
              .filter(([, value]) => Math.abs(value - mean) >= deviation * 3)
              .slice(-50)
              .map(([timestamp, value]) => ({
                timestamp,
                value,
                zScore: (value - mean) / deviation,
                labels: row.labels,
              })),
          );
    return {
      data: { metric, mean, deviation, anomalies: anomalies.slice(-100) },
      evidence: series.evidence.map((item) => ({
        ...item,
        operation: `find_metric_anomalies:${metric}`,
        summary: `${anomalies.length} puntos fuera de tres desviaciones estandar.`,
      })),
    };
  }

  async searchLogs(
    context: RetrievalContext,
    contains = '',
    windowMinutes = 60,
    limit = 50,
  ) {
    const auth = await this.authorize(context, true);
    const seconds = this.windowSeconds(windowMinutes);
    const boundedLimit = this.integer(limit, 1, 100, 'limit');
    const source = `{service_name="ekumetrics-agent",tenant_id="${auth.tenantSlug}",site_id="${auth.siteId}",agent_id="${auth.agentId}"}`;
    const needle = contains.trim().toLowerCase().slice(0, 120);
    const lines = (await this.telemetry.lokiLines(source, seconds, 100))
      .filter((item) => !needle || item.line.toLowerCase().includes(needle))
      .slice(0, boundedLimit)
      .map((item) => ({ ts: item.ts, line: this.redact(item.line) }));
    return this.result('loki', 'search_logs', seconds, lines, lines.length);
  }

  async searchTraces(
    context: RetrievalContext,
    windowMinutes = 60,
    limit = 20,
    minDurationMs = 0,
    errorsOnly = false,
  ) {
    const auth = await this.authorize(context, true);
    const seconds = this.windowSeconds(windowMinutes);
    const boundedLimit = this.integer(limit, 1, 20, 'limit');
    const boundedDuration = this.integer(
      minDurationMs,
      0,
      3_600_000,
      'minDurationMs',
    );
    const predicates = [
      `resource.tenant.id = "${auth.tenantSlug}"`,
      `resource.host.site = "${auth.siteId}"`,
      `resource.agent.id = "${auth.agentId}"`,
      'resource.service.namespace = "ekumetrics"',
    ];
    if (boundedDuration > 0) {
      predicates.push(`trace:duration > ${boundedDuration}ms`);
    }
    if (errorsOnly) predicates.push('span:status = error');
    const traceql = `{ ${predicates.join(' && ')} }`;
    const traces = await this.telemetry.tempoSearch(
      traceql,
      seconds,
      boundedLimit,
      3,
    );
    const traceIds = new Set(traces.map((trace) => trace.traceId));
    const correlatedLogs = traceIds.size
      ? (
          await this.telemetry.lokiLines(
            `{service_name="ekumetrics-agent",tenant_id="${auth.tenantSlug}",site_id="${auth.siteId}",agent_id="${auth.agentId}"}`,
            seconds,
            200,
          )
        )
          .map((item) => ({
            ...item,
            traceId: this.logTraceId(item.fields),
          }))
          .filter((item) => item.traceId && traceIds.has(item.traceId))
          .slice(0, 50)
          .map((item) => ({
            ts: item.ts,
            traceId: item.traceId,
            line: this.redact(item.line),
          }))
      : [];
    const result = this.result(
      'tempo',
      'search_traces',
      seconds,
      { traces, correlatedLogs },
      traces.length,
    );
    const tempoEvidence = result.evidence[0];
    if (tempoEvidence) {
      tempoEvidence.references = traces.map((trace) => ({
        traceId: trace.traceId,
        spanIds: trace.spans.map((span) => span.spanId).filter(Boolean),
        service: trace.rootServiceName,
        operation: trace.rootTraceName,
        durationMs: trace.durationMs,
      }));
    }
    if (traceIds.size) {
      const correlatedEvidence = this.result(
        'loki',
        'correlate_logs_by_trace_id',
        seconds,
        null,
        correlatedLogs.length,
      ).evidence[0];
      if (correlatedEvidence) result.evidence.push(correlatedEvidence);
    }
    return result;
  }

  async getComponentDependencies(context: RetrievalContext) {
    const auth = await this.authorize(context, Boolean(context.agentId));
    const inventory = await this.dashboard.getInventory(
      auth.tenantSlug,
      auth.siteId,
    );
    const forAgent = <T extends { hostId: string }>(items: T[]) =>
      auth.agentId
        ? items.filter((item) => item.hostId === auth.agentId)
        : items;
    const assets = await this.prisma.asset.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(auth.agentDbId ? { agentId: auth.agentDbId } : {}),
      },
      select: {
        assetKey: true,
        assetType: true,
        vendor: true,
        status: true,
        lastObservedAt: true,
      },
      orderBy: { lastObservedAt: 'desc' },
      take: 200,
    });
    const data = {
      hosts: (auth.agentId
        ? inventory.hosts.filter((item) => item.id === auth.agentId)
        : inventory.hosts
      ).slice(0, 100),
      network: forAgent(inventory.networkDevices).slice(0, 100),
      databases: forAgent(inventory.databases).slice(0, 100),
      queues: forAgent(inventory.queues).slice(0, 100),
      sap: forAgent(inventory.sap).slice(0, 100),
      icewarp: forAgent(inventory.icewarp).slice(0, 100),
      assets,
    };
    return this.result(
      'inventory',
      'get_component_dependencies',
      300,
      data,
      Object.values(data).reduce((sum, items) => sum + items.length, 0),
    );
  }

  async getAgentEvents(
    context: RetrievalContext,
    windowMinutes = 60,
    limit = 100,
  ) {
    const auth = await this.authorize(context, Boolean(context.agentId));
    const seconds = this.windowSeconds(windowMinutes);
    const since = new Date(Date.now() - seconds * 1000);
    const events = await this.prisma.agentEvent.findMany({
      where: {
        tenantId: auth.tenantId,
        eventAt: { gte: since },
        ...(auth.agentDbId ? { agentId: auth.agentDbId } : {}),
      },
      select: {
        id: true,
        siteId: true,
        assetKey: true,
        assetType: true,
        signal: true,
        value: true,
        unit: true,
        severity: true,
        source: true,
        eventAt: true,
      },
      orderBy: { eventAt: 'desc' },
      take: this.integer(limit, 1, 200, 'limit'),
    });
    return this.result(
      'postgresql',
      'get_agent_events',
      seconds,
      events,
      events.length,
    );
  }

  async getOpenIncidents(context: RetrievalContext, limit = 100) {
    const auth = await this.authorize(context, Boolean(context.agentId));
    const incidents = await this.prisma.incident.findMany({
      where: {
        tenantId: auth.tenantId,
        status: { in: ['open', 'acknowledged'] },
        ...(auth.agentDbId
          ? { asset: { is: { agentId: auth.agentDbId } } }
          : {}),
      },
      select: {
        id: true,
        title: true,
        severity: true,
        status: true,
        causeName: true,
        confidence: true,
        alertCount: true,
        createdAt: true,
        updatedAt: true,
        asset: { select: { assetKey: true, assetType: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: this.integer(limit, 1, 100, 'limit'),
    });
    return this.result(
      'postgresql',
      'get_open_incidents',
      86_400,
      incidents,
      incidents.length,
    );
  }

  private async authorize(
    context: RetrievalContext,
    requireAgent: boolean,
  ): Promise<AuthorizedContext> {
    const tenantSlug = this.identifier(context.tenantSlug, 'tenant');
    if (!context.actor.trim()) {
      throw new BadRequestException('La herramienta requiere un actor.');
    }
    const agentId = context.agentId
      ? this.identifier(context.agentId, 'agente')
      : undefined;
    if (requireAgent && !agentId) {
      throw new BadRequestException('La herramienta requiere un agente.');
    }
    let tenant: { id: string; slug: string } | null;
    try {
      tenant = await this.prisma.tenant.findUnique({
        where: { slug: tenantSlug },
        select: { id: true, slug: true },
      });
    } catch {
      throw new ServiceUnavailableException(
        'No fue posible validar el tenant.',
      );
    }
    if (!tenant) throw new ForbiddenException('Contexto no autorizado.');
    if (!agentId) return { ...context, tenantId: tenant.id, tenantSlug };
    const agent = await this.prisma.agent.findUnique({
      where: { tenantId_agentId: { tenantId: tenant.id, agentId } },
      select: { id: true, agentId: true, siteId: true },
    });
    if (!agent) throw new ForbiddenException('Contexto no autorizado.');
    if (context.siteId && context.siteId !== agent.siteId) {
      throw new ForbiddenException('Contexto no autorizado.');
    }
    return {
      ...context,
      tenantId: tenant.id,
      tenantSlug,
      agentDbId: agent.id,
      agentId: agent.agentId,
      siteId: agent.siteId,
    };
  }

  private metricQuery(auth: AuthorizedContext, metric: RetrievalMetric) {
    const sel = this.selector(auth);
    const catalog: Record<RetrievalMetric, string> = {
      cpu_used_ratio: `1 - sum(rate(system_cpu_time_seconds_total${this.selector(auth, ['state="idle"'])}[5m])) / sum(rate(system_cpu_time_seconds_total${sel}[5m]))`,
      memory_used_ratio: `sum(system_memory_usage_bytes${this.selector(auth, ['state="used"'])}) / sum(system_memory_usage_bytes${sel})`,
      load_1m: `max(system_cpu_load_average_1m${sel})`,
      network_receive_bps: `sum(rate(system_network_io_bytes_total${this.selector(auth, ['direction="receive"', 'device!="lo"'])}[5m]))`,
      network_transmit_bps: `sum(rate(system_network_io_bytes_total${this.selector(auth, ['direction="transmit"', 'device!="lo"'])}[5m]))`,
      process_cpu_seconds: `sum by (process) (rate(process_cpu_time_seconds_total${sel}[5m]))`,
      database_presence: `sum(ekms_datastore_up${sel})`,
      queue_presence: `sum(nats_varz_connections${sel}) or sum(kafka_brokers${sel}) or sum(rabbitmq_consumer_count${sel})`,
      sap_sessions: `sum(ekms_sap_sessions_total${sel})`,
      icewarp_service_running: `sum by (icewarp_svc) (icewarp_svc_running${sel})`,
    };
    const query = catalog[metric];
    if (!query) throw new BadRequestException('Metrica no permitida.');
    return query;
  }

  private selector(auth: AuthorizedContext, extra: string[] = []) {
    if (!auth.agentId || !auth.siteId) {
      throw new BadRequestException(
        'La herramienta requiere un agente autorizado.',
      );
    }
    return `{${[
      `tenant_id="${auth.tenantSlug}"`,
      `site_id="${auth.siteId}"`,
      `agent_id="${auth.agentId}"`,
      ...extra,
    ].join(',')}}`;
  }

  private result<T>(
    source: RetrievalEvidence['source'],
    operation: string,
    seconds: number,
    data: T,
    count: number,
  ): { data: T; evidence: RetrievalEvidence[] } {
    const end = new Date();
    const start = new Date(end.getTime() - seconds * 1000);
    return {
      data,
      evidence: [
        {
          id: `${source}:${operation}:${end.getTime()}`,
          source,
          operation,
          window: { start: start.toISOString(), end: end.toISOString() },
          summary: `${count} resultados dentro de los limites autorizados.`,
          timestamp: end.toISOString(),
          resultCount: count,
        },
      ],
    };
  }

  private windowSeconds(minutes: number) {
    return this.integer(minutes, 1, 1_440, 'windowMinutes') * 60;
  }

  private integer(value: number, min: number, max: number, field: string) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new BadRequestException(
        `${field} debe estar entre ${min} y ${max}.`,
      );
    }
    return value;
  }

  private identifier(value: string, field: string) {
    const clean = value.trim();
    if (!clean || !/^[A-Za-z0-9._-]+$/.test(clean)) {
      throw new BadRequestException(`Identificador de ${field} invalido.`);
    }
    return clean;
  }

  private safeLabels(labels: Record<string, string>) {
    return Object.fromEntries(
      Object.entries(labels)
        .filter(([key]) =>
          ['process', 'direction', 'icewarp_svc', 'database_name'].includes(
            key,
          ),
        )
        .slice(0, 10),
    );
  }

  private logTraceId(fields: Record<string, string>) {
    const candidate =
      fields.trace_id ?? fields.traceID ?? fields.traceId ?? fields.traceid;
    return candidate && /^[a-fA-F0-9]{16,32}$/.test(candidate)
      ? candidate.toLowerCase()
      : '';
  }

  private redact(value: string) {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
      .replace(
        /((?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*)[^\s,;]+/gi,
        '$1[REDACTED]',
      )
      .slice(0, 2_000);
  }
}
