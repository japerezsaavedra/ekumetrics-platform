import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  AI_PROVIDERS,
  AI_SERVICES,
  HOLMES_MODEL_KEYS,
  findService,
  type AiProvider,
  type AiServiceDef,
} from './ai.providers';

type HolmesChatResponse = {
  analysis?: string;
  tool_calls?: unknown;
};

type StoredAiSettings = {
  service: string;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
};

type SaveAiSettingsInput = {
  service?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
};

export type HostSnapshot = {
  agentId: string;
  found: boolean;
  tenantId: string | null;
  siteId: string | null;
  cpus: number | null;
  cpuHostPercent: number | null;
  load1m: number | null;
  load5m: number | null;
  load15m: number | null;
  memoryUsedPercent: number | null;
  logs: { source: string; lines: string[] };
  forecast: {
    method: string;
    cpuHostNow: number | null;
    cpuHostIn15m: number | null;
    note: string;
  };
  assessment: {
    verdict: 'ok' | 'watch' | 'anomaly';
    findings: string[];
    cpuAvg1h: number | null;
    cpuMax1h: number | null;
  };
  traces: { available: boolean; note: string };
};

@Injectable()
export class AiService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async status() {
    const stored = await this.getStoredSettings();
    const defaultProvider = stored?.service ?? this.defaultProvider();
    const activeService = findService(defaultProvider) ?? AI_SERVICES[0];
    return {
      defaultProvider,
      defaultService: defaultProvider,
      holmesUrl: this.holmesUrl(),
      active: {
        service: activeService.id,
        label: activeService.label,
        model: stored?.model ?? this.serviceDefaultModel(activeService),
        configured: this.isServiceConfigured(activeService, stored),
        investigator: 'holmes',
      },
      services: AI_SERVICES.map((item) => ({
        id: item.id,
        label: item.label,
        models: item.models,
        defaultModel: this.serviceDefaultModel(item),
        configured: this.isServiceConfigured(item, stored),
        needsKey: item.keyEnv.length > 0,
        needsBaseUrl: item.id === 'openai_compat',
        hint: item.hint,
      })),
      providers: AI_PROVIDERS.map((id) => ({
        id,
        configured: this.isConfigured(id),
        holmesModel: HOLMES_MODEL_KEYS[id],
      })),
    };
  }

  async getSettings() {
    const status = await this.status();
    const stored = await this.getStoredSettings();
    return {
      service: status.active.service,
      model: status.active.model,
      baseUrl: stored?.baseUrl ?? '',
      hasApiKey: Boolean(stored?.apiKey),
      services: status.services,
    };
  }

  async saveSettings(input: SaveAiSettingsInput) {
    const service = this.resolveService(input.service);
    const model = (input.model ?? '').trim();
    if (!model) {
      throw new BadRequestException('El modelo es obligatorio');
    }
    const existing = await this.getStoredSettings();
    const apiKey = input.apiKey?.trim() || (existing?.service === service.id ? existing.apiKey : null);
    const baseUrl =
      (input.baseUrl ?? '').trim() ||
      (existing?.service === service.id ? existing.baseUrl : null) ||
      service.baseUrl ||
      null;
    const next: StoredAiSettings = {
      service: service.id,
      model,
      apiKey,
      baseUrl,
    };
    if (!this.isServiceConfigured(service, next)) {
      throw new BadRequestException(
        service.id === 'openai_compat'
          ? 'Indique URL base y clave API'
          : `Indique la clave API de ${service.label}`,
      );
    }
    const saved = await this.prisma.aiSettings.upsert({
      where: { slot: 'default' },
      create: {
        slot: 'default',
        service: next.service,
        model: next.model,
        apiKey: next.apiKey,
        baseUrl: next.baseUrl,
      },
      update: {
        service: next.service,
        model: next.model,
        apiKey: next.apiKey,
        baseUrl: next.baseUrl,
      },
    });
    return {
      service: saved.service,
      model: saved.model,
      baseUrl: saved.baseUrl ?? '',
      hasApiKey: Boolean(saved.apiKey),
    };
  }

  async ask(question: string, providerInput?: string, modelInput?: string) {
    const trimmed = question.trim();
    if (!trimmed) {
      throw new BadRequestException('La pregunta es obligatoria');
    }
    const stored = await this.getStoredSettings();
    const service = this.resolveService(providerInput || stored?.service);
    if (!this.isServiceConfigured(service, stored)) {
      throw new BadRequestException(
        `El servicio ${service.label} no tiene credenciales. Configure el modelo en el portal.`,
      );
    }

    const model = this.resolveModel(service, modelInput || stored?.model);
    const { facts, snapshot } = await this.investigationContext(trimmed);
    const result = await this.callHolmes(trimmed, facts, model);
    const analysis = this.composeAnalysis(snapshot, result.analysis);

    const saved = await this.prisma.aiInquiry.create({
      data: {
        provider: service.id,
        model,
        question: trimmed,
        analysis,
        evidence: result.evidence ?? undefined,
      },
    });

    return {
      id: saved.id,
      provider: 'holmes',
      service: service.id,
      model,
      question: trimmed,
      analysis,
      evidence: result.evidence,
      snapshot,
    };
  }

  async snapshot(agentIdInput?: string | null): Promise<HostSnapshot | null> {
    const agentId = (agentIdInput ?? '').trim().replace(/"/g, '');
    if (!agentId) {
      return null;
    }
    try {
      const cpuQuery = `1 - sum(rate(system_cpu_time_seconds_total{agent_id="${agentId}",state="idle"}[5m])) / sum(rate(system_cpu_time_seconds_total{agent_id="${agentId}"}[5m]))`;
      const [identity, cpus, cpu, load1, load5, load15, mem, logs, cpuSeries] =
        await Promise.all([
          this.promInstant(`ekms_agent_identity{agent_id="${agentId}"}`),
          this.promInstant(`system_cpu_logical_count{agent_id="${agentId}"}`),
          this.promInstant(cpuQuery),
          this.promInstant(`system_cpu_load_average_1m{agent_id="${agentId}"}`),
          this.promInstant(`system_cpu_load_average_5m{agent_id="${agentId}"}`),
          this.promInstant(`system_cpu_load_average_15m{agent_id="${agentId}"}`),
          this.promInstant(
            `sum(system_memory_usage_bytes{agent_id="${agentId}",state="used"}) / sum(system_memory_usage_bytes{agent_id="${agentId}"})`,
          ),
          this.lokiLines(),
          this.promRange(cpuQuery, 3600, 60),
        ]);
      const ident = identity[0]?.metric ?? {};
      const finite = (value: number | undefined) =>
        value !== undefined && Number.isFinite(value) ? value : null;
      const cpuHostPercent =
        finite(cpu[0]?.value) === null ? null : (cpu[0].value as number) * 100;
      const forecast = this.forecastCpu(cpuHostPercent, cpuSeries);
      const stats = this.cpuStats(cpuSeries);
      const host = {
        agentId: ident.agent_id ?? agentId,
        found: identity.length > 0 || cpus.length > 0,
        tenantId: ident.tenant_id ?? null,
        siteId: ident.site_id ?? null,
        cpus: finite(cpus[0]?.value),
        cpuHostPercent,
        load1m: finite(load1[0]?.value),
        load5m: finite(load5[0]?.value),
        load15m: finite(load15[0]?.value),
        memoryUsedPercent:
          finite(mem[0]?.value) === null ? null : (mem[0].value as number) * 100,
        logs,
        forecast,
        traces: {
          available: false,
          note: 'Las trazas solo van al exporter debug. Falta un backend (Tempo).',
        },
      };
      return {
        ...host,
        assessment: this.assessHost(host, stats),
      };
    } catch {
      return this.emptySnapshot(agentId);
    }
  }

  private defaultProvider(): string {
    const raw = (this.config.get<string>('AI_DEFAULT_PROVIDER') ?? 'ollama').trim();
    return findService(raw)?.id ?? 'ollama';
  }

  private holmesUrl(): string {
    return (this.config.get<string>('HOLMES_URL') ?? 'http://localhost:5050').replace(
      /\/$/,
      '',
    );
  }

  private resolveService(input?: string): AiServiceDef {
    if (!input || !input.trim()) {
      return findService(this.defaultProvider()) ?? AI_SERVICES[0];
    }
    const service = findService(input);
    if (!service) {
      throw new BadRequestException(
        `Servicio no soportado: ${input}. Use ${AI_SERVICES.map((item) => item.id).join(', ')}`,
      );
    }
    return service;
  }

  private transportProvider(service: AiServiceDef): AiProvider {
    if (service.transport === 'holmes') {
      return 'ollama';
    }
    if (service.transport === 'anthropic') {
      return 'anthropic';
    }
    if (service.transport === 'openai') {
      return 'openai';
    }
    return 'openai_compat';
  }

  private async getStoredSettings(): Promise<StoredAiSettings | null> {
    try {
      const row = await this.prisma.aiSettings.findUnique({ where: { slot: 'default' } });
      if (!row) {
        return null;
      }
      return {
        service: row.service,
        model: row.model,
        apiKey: row.apiKey,
        baseUrl: row.baseUrl,
      };
    } catch {
      return null;
    }
  }

  private isServiceConfigured(
    service: AiServiceDef,
    stored?: StoredAiSettings | null,
  ): boolean {
    if (service.id === 'ollama') {
      return true;
    }
    const creds = this.resolveCredentials(service, stored);
    if (service.id === 'openai_compat') {
      return Boolean(creds.baseUrl && creds.apiKey);
    }
    return Boolean(creds.apiKey);
  }

  async upstreamCompletions(payload: Record<string, unknown>, authorization?: string) {
    const expected = (this.config.get<string>('HOLMES_UPSTREAM_KEY') ?? 'holmes-local').trim();
    const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token || token !== expected) {
      throw new UnauthorizedException();
    }
    const stored = await this.getStoredSettings();
    const service = this.resolveService(stored?.service);
    if (!this.isServiceConfigured(service, stored)) {
      throw new BadRequestException(
        `El servicio ${service.label} no tiene credenciales. Configure el modelo en el portal.`,
      );
    }
    const model = this.resolveModel(service, stored?.model);
    if (service.transport === 'anthropic') {
      return this.upstreamAnthropic(payload, service, stored, model);
    }
    const creds = this.resolveCredentials(service, stored);
    const base = (creds.baseUrl ?? '').replace(/\/$/, '');
    if (!base) {
      throw new BadRequestException('Falta la URL del modelo');
    }
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {}),
      },
      body: JSON.stringify({ ...payload, model, stream: false }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new ServiceUnavailableException(
        body.error?.message ?? `El modelo respondio ${response.status}`,
      );
    }
    return body;
  }

  private resolveCredentials(
    service: AiServiceDef,
    stored?: StoredAiSettings | null,
  ): { apiKey?: string; baseUrl?: string } {
    if (service.id === 'ollama') {
      return {
        apiKey: 'ollama',
        baseUrl: (
          this.config.get<string>('OLLAMA_URL') ?? 'http://127.0.0.1:11434/v1'
        ).replace(/\/$/, ''),
      };
    }
    const fromDb = stored?.service === service.id ? stored : null;
    return {
      apiKey: fromDb?.apiKey?.trim() || this.firstKey(service.keyEnv),
      baseUrl: (
        fromDb?.baseUrl ||
        service.baseUrl ||
        this.config.get<string>('AI_COMPAT_BASE_URL') ||
        ''
      ).replace(/\/$/, ''),
    };
  }

  private firstKey(envs: string[]): string | undefined {
    for (const name of envs) {
      const value = this.config.get<string>(name)?.trim();
      if (value && !name.endsWith('_BASE_URL') && !name.endsWith('_MODEL')) {
        return value;
      }
    }
    return undefined;
  }

  private serviceDefaultModel(service: AiServiceDef): string {
    if (service.id === 'openai_compat') {
      return this.config.get<string>('AI_COMPAT_MODEL')?.trim() || service.defaultModel;
    }
    return service.defaultModel;
  }

  private resolveModel(service: AiServiceDef, modelInput?: string): string {
    const requested = modelInput?.trim();
    if (requested) {
      return requested;
    }
    return this.serviceDefaultModel(service) || this.modelName(this.transportProvider(service));
  }

  private isConfigured(provider: AiProvider): boolean {
    switch (provider) {
      case 'ollama':
        return true;
      case 'openai':
        return Boolean(this.config.get<string>('OPENAI_API_KEY')?.trim());
      case 'anthropic':
        return Boolean(this.config.get<string>('ANTHROPIC_API_KEY')?.trim());
      case 'openai_compat':
        return Boolean(
          this.config.get<string>('AI_COMPAT_BASE_URL')?.trim() &&
            this.config.get<string>('AI_COMPAT_API_KEY')?.trim(),
        );
      default:
        return false;
    }
  }

  private modelName(provider: AiProvider): string {
    switch (provider) {
      case 'ollama':
        return 'qwen2.5:14b';
      case 'openai':
        return this.config.get<string>('OPENAI_MODEL')?.trim() || 'gpt-4.1-mini';
      case 'anthropic':
        return this.config.get<string>('ANTHROPIC_MODEL')?.trim() || 'claude-sonnet-4-5';
      case 'openai_compat':
        return this.config.get<string>('AI_COMPAT_MODEL')?.trim() || 'unknown';
      default:
        return 'unknown';
    }
  }

  private prometheusUrl(): string {
    return (this.config.get<string>('PROMETHEUS_URL') ?? 'http://127.0.0.1:9091').replace(
      /\/$/,
      '',
    );
  }

  private async investigationContext(question: string): Promise<{
    facts: string;
    snapshot: HostSnapshot | null;
  }> {
    const agents = await this.listConnectedAgents();
    const named = this.extractAgentId(question);
    const targetIds = named
      ? [named]
      : agents.slice(0, 5).map((item) => item.agentId);
    const snapshots = (
      await Promise.all(targetIds.map((id) => this.snapshot(id)))
    ).filter((item): item is HostSnapshot => Boolean(item));
    return {
      facts: this.contextFacts(agents, snapshots),
      snapshot: snapshots[0] ?? null,
    };
  }

  private async listConnectedAgents(): Promise<
    Array<{ agentId: string; tenantId: string | null; siteId: string | null }>
  > {
    try {
      const rows = await this.promInstant('ekms_agent_identity');
      const unique = new Map<
        string,
        { agentId: string; tenantId: string | null; siteId: string | null }
      >();
      for (const row of rows) {
        const agentId = row.metric.agent_id?.trim();
        if (!agentId || unique.has(agentId)) {
          continue;
        }
        unique.set(agentId, {
          agentId,
          tenantId: row.metric.tenant_id ?? null,
          siteId: row.metric.site_id ?? null,
        });
      }
      return [...unique.values()];
    } catch {
      return [];
    }
  }

  private contextFacts(
    agents: Array<{ agentId: string; tenantId: string | null; siteId: string | null }>,
    snapshots: HostSnapshot[],
  ): string {
    const lines = [
      'Laboratorio Ekumetrics. Estos hechos salen de Prometheus ahora.',
      'Usted es los ojos expertos del equipo. La lectura_experta ya clasifica cada host.',
      `agentes_conectados=${agents.length}`,
    ];
    if (!agents.length) {
      lines.push('No hay ekms_agent_identity. El agente no esta reportando.');
    } else {
      for (const agent of agents) {
        lines.push(
          `- agent_id=${agent.agentId} tenant=${agent.tenantId ?? 'sin datos'} site=${agent.siteId ?? 'sin datos'}`,
        );
      }
    }
    for (const snapshot of snapshots) {
      const host = this.factsText(snapshot);
      if (host) {
        lines.push('', host);
      }
    }
    return lines.join('\n');
  }

  private extractAgentId(question: string): string | null {
    const labeled = question.match(/agent_id\s*[:=]\s*["']?([A-Za-z0-9._-]+)/i);
    if (labeled?.[1]) {
      return labeled[1];
    }
    const named = question.match(/agente\s+([A-Za-z0-9._-]+)/i);
    if (named?.[1]) {
      return named[1];
    }
    const dashed = question.match(/\b(agent-[A-Za-z0-9._-]+)\b/i);
    return dashed?.[1] ?? null;
  }

  private async promInstant(
    query: string,
  ): Promise<Array<{ metric: Record<string, string>; value: number }>> {
    const url = `${this.prometheusUrl()}/api/v1/query?query=${encodeURIComponent(query)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = (await response.json()) as {
      data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> };
    };
    return (body.data?.result ?? []).map((row) => ({
      metric: row.metric ?? {},
      value: Number(row.value?.[1] ?? Number.NaN),
    }));
  }

  private async promRange(
    query: string,
    seconds: number,
    step: number,
  ): Promise<Array<[number, number]>> {
    const end = Math.floor(Date.now() / 1000);
    const start = end - seconds;
    const url = `${this.prometheusUrl()}/api/v1/query_range?${new URLSearchParams({
      query,
      start: String(start),
      end: String(end),
      step: String(step),
    }).toString()}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = (await response.json()) as {
      data?: { result?: Array<{ values?: Array<[number, string]> }> };
    };
    const values = body.data?.result?.[0]?.values ?? [];
    return values
      .map(([ts, raw]) => [Number(ts), Number(raw)] as [number, number])
      .filter(([, value]) => Number.isFinite(value));
  }

  private lokiUrl(): string {
    return (this.config.get<string>('LOKI_URL') ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
  }

  private async lokiLines(): Promise<{ source: string; lines: string[] }> {
    const source = '{service_name="ekumetrics-agent"}';
    try {
      const end = Date.now() * 1_000_000;
      const start = end - 15 * 60 * 1_000_000_000;
      const url = `${this.lokiUrl()}/loki/api/v1/query_range?${new URLSearchParams({
        query: source,
        start: String(start),
        end: String(end),
        limit: '5',
        direction: 'backward',
      }).toString()}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const body = (await response.json()) as {
        data?: { result?: Array<{ values?: Array<[string, string]> }> };
      };
      const lines = (body.data?.result ?? [])
        .flatMap((stream) => stream.values ?? [])
        .slice(0, 5)
        .map(([, line]) => this.logLine(line));
      return { source, lines };
    } catch {
      return { source, lines: [] };
    }
  }

  private logLine(raw: string): string {
    try {
      const parsed = JSON.parse(raw) as { MESSAGE?: string };
      return parsed.MESSAGE ?? raw;
    } catch {
      return raw;
    }
  }

  private forecastCpu(
    now: number | null,
    series: Array<[number, number]>,
  ): HostSnapshot['forecast'] {
    const note = 'Proyeccion lineal 15m. TimesFM/Chronos se incorporara despues.';
    if (series.length < 2) {
      return { method: 'linear-15m', cpuHostNow: now, cpuHostIn15m: now, note };
    }
    const first = series[0];
    const last = series[series.length - 1];
    const dt = last[0] - first[0];
    if (dt <= 0) {
      return { method: 'linear-15m', cpuHostNow: now, cpuHostIn15m: now, note };
    }
    const slope = ((last[1] - first[1]) * 100) / dt;
    const current = now ?? last[1] * 100;
    const projected = Math.min(100, Math.max(0, current + slope * 900));
    return {
      method: 'linear-15m',
      cpuHostNow: current,
      cpuHostIn15m: projected,
      note,
    };
  }

  private emptySnapshot(agentId: string): HostSnapshot {
    return {
      agentId,
      found: false,
      tenantId: null,
      siteId: null,
      cpus: null,
      cpuHostPercent: null,
      load1m: null,
      load5m: null,
      load15m: null,
      memoryUsedPercent: null,
      logs: { source: '{service_name="ekumetrics-agent"}', lines: [] },
      forecast: {
        method: 'linear-15m',
        cpuHostNow: null,
        cpuHostIn15m: null,
        note: 'Sin serie para proyectar.',
      },
      assessment: {
        verdict: 'anomaly',
        findings: ['El agente no reporta metricas en Prometheus.'],
        cpuAvg1h: null,
        cpuMax1h: null,
      },
      traces: {
        available: false,
        note: 'Las trazas solo van al exporter debug. Falta un backend (Tempo).',
      },
    };
  }

  private cpuStats(series: Array<[number, number]>): {
    avg: number | null;
    max: number | null;
  } {
    const values = series.map(([, value]) => value * 100).filter((value) => Number.isFinite(value));
    if (!values.length) {
      return { avg: null, max: null };
    }
    return {
      avg: values.reduce((sum, value) => sum + value, 0) / values.length,
      max: Math.max(...values),
    };
  }

  private assessHost(
    host: Omit<HostSnapshot, 'assessment'>,
    stats: { avg: number | null; max: number | null },
  ): HostSnapshot['assessment'] {
    const findings: string[] = [];
    let verdict: HostSnapshot['assessment']['verdict'] = 'ok';
    const raise = (next: HostSnapshot['assessment']['verdict']) => {
      if (next === 'anomaly' || (next === 'watch' && verdict === 'ok')) {
        verdict = next;
      }
    };
    const cpu = host.cpuHostPercent;
    const cpus = host.cpus;
    const load = host.load1m;
    const mem = host.memoryUsedPercent;
    const projected = host.forecast.cpuHostIn15m;

    if (!host.found) {
      return {
        verdict: 'anomaly',
        findings: ['Sin series de este agente en Prometheus.'],
        cpuAvg1h: stats.avg,
        cpuMax1h: stats.max,
      };
    }
    if (cpu !== null && cpu >= 85) {
      findings.push(`CPU host ${cpu.toFixed(2)}% supera 85%.`);
      raise('anomaly');
    } else if (cpu !== null && cpu >= 70) {
      findings.push(`CPU host ${cpu.toFixed(2)}% esta alta (umbral 70%).`);
      raise('watch');
    }
    if (cpu !== null && stats.avg !== null && cpu - stats.avg >= 35) {
      findings.push(
        `CPU ahora esta ${ (cpu - stats.avg).toFixed(1) } puntos sobre la media de 1h (${stats.avg.toFixed(2)}%).`,
      );
      raise('anomaly');
    } else if (cpu !== null && stats.avg !== null && cpu - stats.avg >= 20) {
      findings.push(
        `CPU ahora esta ${ (cpu - stats.avg).toFixed(1) } puntos sobre la media de 1h (${stats.avg.toFixed(2)}%).`,
      );
      raise('watch');
    }
    if (load !== null && cpus !== null && cpus > 0 && load > cpus * 2) {
      findings.push(`Load 1m ${load.toFixed(2)} duplica las ${cpus.toFixed(0)} CPUs.`);
      raise('anomaly');
    } else if (load !== null && cpus !== null && cpus > 0 && load > cpus * 1.2) {
      findings.push(`Load 1m ${load.toFixed(2)} supera las ${cpus.toFixed(0)} CPUs.`);
      raise('watch');
    }
    if (mem !== null && mem >= 90) {
      findings.push(`Memoria usada ${mem.toFixed(2)}% supera 90%.`);
      raise('anomaly');
    } else if (mem !== null && mem >= 80) {
      findings.push(`Memoria usada ${mem.toFixed(2)}% esta alta (umbral 80%).`);
      raise('watch');
    }
    if (projected !== null && projected >= 85 && (cpu === null || cpu < 70)) {
      findings.push(`La proyeccion lineal a 15m llega a ${projected.toFixed(2)}% CPU.`);
      raise('watch');
    }
    if (!findings.length) {
      findings.push('CPU, load y memoria estan dentro de lo visto en la ultima hora.');
    }
    return {
      verdict,
      findings,
      cpuAvg1h: stats.avg,
      cpuMax1h: stats.max,
    };
  }

  private investigatorPrompt(): string {
    return [
      'Eres los ojos expertos de operaciones de Ekumetrics.',
      'Responda solo la pregunta, en espanol, en texto plano.',
      'Prohibido markdown: nada de asteriscos, almohadillas, rayas ---, ni backticks.',
      'No use titulos, listas con viñetas ni etiquetas como lectura_experta.',
      'No agregue datos, logs ni metricas que no pidieron.',
      'Si preguntan si hay anomalias, diga si esta bien o no y por que, en dos o tres frases.',
      'Use solo los hechos. No invente Kubernetes, PromQL ni kubectl.',
    ].join(' ');
  }

  private composeAnalysis(_snapshot: HostSnapshot | null, explanation: string): string {
    return this.plainReply(explanation);
  }

  private plainReply(text: string): string {
    const marker = 'Explicacion:';
    const index = text.indexOf(marker);
    let value = (index >= 0 ? text.slice(index + marker.length) : text).trim();
    value = value.replace(/\*\*?/g, '');
    value = value.replace(/__/g, '');
    value = value.replace(/`+/g, '');
    value = value.replace(/^#{1,6}\s+/gm, '');
    value = value.replace(/^\s*-{3,}\s*$/gm, '');
    value = value.replace(/^lectura_experta:\s*/gim, '');
    return value.replace(/\n{3,}/g, '\n\n').trim();
  }

  private factsText(snapshot: HostSnapshot | null): string {
    if (!snapshot?.found) {
      return '';
    }
    const pct = (n: number | null) => (n === null ? 'sin datos' : `${n.toFixed(2)}%`);
    const num = (n: number | null, digits = 2) =>
      n === null ? 'sin datos' : n.toFixed(digits);
    return [
      'Hechos de Prometheus. Usa estos numeros; no los contradigas ni relances las mismas queries.',
      `agent_id=${snapshot.agentId}`,
      `tenant_id=${snapshot.tenantId ?? 'sin datos'}`,
      `site_id=${snapshot.siteId ?? 'sin datos'}`,
      `cpus=${num(snapshot.cpus, 0)}`,
      `cpu_host=${pct(snapshot.cpuHostPercent)}`,
      `load_1m=${num(snapshot.load1m)}`,
      `load_5m=${num(snapshot.load5m)}`,
      `load_15m=${num(snapshot.load15m)}`,
      `memoria_usada=${pct(snapshot.memoryUsedPercent)}`,
      `cpu_media_1h=${pct(snapshot.assessment.cpuAvg1h)}`,
      `cpu_max_1h=${pct(snapshot.assessment.cpuMax1h)}`,
      `cpu_host_en_15m=${pct(snapshot.forecast.cpuHostIn15m)} (${snapshot.forecast.note})`,
      `lectura_experta=${snapshot.assessment.verdict}`,
      ...snapshot.assessment.findings.map((item) => `- hallazgo: ${item}`),
      `logs=${snapshot.logs.lines.length} lineas ${snapshot.logs.source}`,
      ...snapshot.logs.lines.map((line) => `- ${line}`),
      `trazas=${snapshot.traces.available ? 'si' : 'no'}. ${snapshot.traces.note}`,
    ].join('\n');
  }

  private async callHolmes(question: string, facts: string, model: string) {
    const url = `${this.holmesUrl()}/api/chat`;
    const ask = facts ? `${facts}\n\nPregunta del usuario: ${question}` : question;
    const holmesModel = model.includes('/') ? model : `openai/${model}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ask,
          model: holmesModel,
          additional_system_prompt: this.investigatorPrompt(),
        }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      throw new ServiceUnavailableException(
        'HolmesGPT no responde. Arranque el perfil ai y Ollama en 0.0.0.0:11434.',
      );
    }

    const body = (await response.json().catch(() => ({}))) as HolmesChatResponse & {
      detail?: string;
    };
    if (!response.ok) {
      throw new ServiceUnavailableException(
        body.detail ?? `HolmesGPT respondio ${response.status}`,
      );
    }

    return {
      analysis: body.analysis ?? '',
      evidence: body.tool_calls ?? null,
    };
  }

  private async callChat(
    provider: AiProvider,
    question: string,
    model: string,
    facts: string,
    service: AiServiceDef,
    stored?: StoredAiSettings | null,
  ) {
    const system = this.investigatorPrompt();
    const user = facts ? `${facts}\n\nPregunta del usuario: ${question}` : question;
    try {
      if (provider === 'anthropic') {
        return await this.callAnthropic(system, user, model, service, stored);
      }
      return await this.callOpenAiCompat(provider, system, user, model, service, stored);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new ServiceUnavailableException('El proveedor de IA no respondio');
    }
  }

  private async callOpenAiCompat(
    provider: AiProvider,
    system: string,
    question: string,
    model: string,
    service: AiServiceDef,
    stored?: StoredAiSettings | null,
  ) {
    const creds = this.resolveCredentials(service, stored);
    const base = (
      creds.baseUrl ||
      (provider === 'openai' ? 'https://api.openai.com/v1' : '')
    ).replace(/\/$/, '');
    const key = creds.apiKey;
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: question },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new ServiceUnavailableException(
        body.error?.message ?? `El proveedor respondio ${response.status}`,
      );
    }
    return {
      analysis: body.choices?.[0]?.message?.content ?? '',
      evidence: null,
    };
  }

  private async callAnthropic(
    system: string,
    question: string,
    model: string,
    service: AiServiceDef,
    stored?: StoredAiSettings | null,
  ) {
    const key = this.resolveCredentials(service, stored).apiKey ?? '';
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: question }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      content?: Array<{ text?: string }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new ServiceUnavailableException(
        body.error?.message ?? `Claude respondio ${response.status}`,
      );
    }
    return {
      analysis: body.content?.[0]?.text ?? '',
      evidence: null,
    };
  }

  private async upstreamAnthropic(
    payload: Record<string, unknown>,
    service: AiServiceDef,
    stored: StoredAiSettings | null,
    model: string,
  ) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const system = messages
      .filter((item): item is { role: string; content: string } => {
        return Boolean(
          item &&
            typeof item === 'object' &&
            'role' in item &&
            (item as { role?: string }).role === 'system',
        );
      })
      .map((item) => item.content)
      .join('\n');
    const user = messages
      .filter((item): item is { role: string; content: string } => {
        return Boolean(
          item &&
            typeof item === 'object' &&
            'role' in item &&
            (item as { role?: string }).role !== 'system',
        );
      })
      .map((item) => `${item.role}: ${item.content}`)
      .join('\n');
    const result = await this.callAnthropic(system, user, model, service, stored);
    return {
      id: 'holmes-anthropic',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: result.analysis } }],
    };
  }
}
