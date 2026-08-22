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
import {
  composeInvestigatorPrompt,
  sanitizeAssistantReply,
  userComplement,
} from './investigator-prompt';

type FactScope = {
  cpu: boolean;
  load: boolean;
  memory: boolean;
  network: boolean;
  logs: boolean;
  traces: boolean;
  forecast: boolean;
  hourStats: boolean;
  dayStats: boolean;
};

type HolmesChatResponse = {
  analysis?: string;
  tool_calls?: unknown;
};

type VaultEntry = {
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
};

type Vault = Record<string, VaultEntry>;

type StoredAiSettings = {
  service: string;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
  systemPrompt: string | null;
  vault: Vault;
};

type SaveAiSettingsInput = {
  service?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  systemPrompt?: string;
};

export type HostSnapshot = {
  agentId: string;
  found: boolean;
  tenantId: string | null;
  siteId: string | null;
  mode: string | null;
  cpus: number | null;
  cpuHostPercent: number | null;
  cpuByState: Array<{ state: string; percent: number }>;
  load1m: number | null;
  load5m: number | null;
  load15m: number | null;
  memoryUsedPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  networkReceiveBps: number | null;
  networkTransmitBps: number | null;
  networkErrorsPerSec: number | null;
  networkDropsPerSec: number | null;
  uptimeSeconds: number | null;
  modules: string[];
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
    cpuMaxAt: number | null;
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
    const model = stored?.model ?? this.serviceDefaultModel(activeService);
    const configured = this.isServiceConfigured(activeService, stored);
    const probe = await this.probeActive(activeService, stored, model);
    return {
      defaultProvider,
      defaultService: defaultProvider,
      holmesUrl: this.holmesUrl(),
      active: {
        service: activeService.id,
        label: activeService.label,
        model,
        configured,
        investigator: 'holmes',
        ...probe,
      },
      services: AI_SERVICES.map((item) => {
        const saved = stored?.vault[item.id];
        return {
          id: item.id,
          label: item.label,
          models: item.models,
          defaultModel: this.serviceDefaultModel(item),
          configured: this.isServiceConfigured(item, stored),
          hasApiKey: Boolean(saved?.apiKey),
          savedModel: saved?.model ?? '',
          savedBaseUrl: item.id === 'openai_compat' ? (saved?.baseUrl ?? '') : '',
          needsKey: item.keyEnv.length > 0,
          needsBaseUrl: item.id === 'openai_compat',
          hint: item.hint,
        };
      }),
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
      hasApiKey: Boolean(stored?.vault[status.active.service]?.apiKey),
      systemPrompt: userComplement(stored?.systemPrompt),
      services: status.services,
      active: status.active,
    };
  }

  async saveSettings(input: SaveAiSettingsInput) {
    const service = this.resolveService(input.service);
    const model = (input.model ?? '').trim();
    if (!model) {
      throw new BadRequestException('El modelo es obligatorio');
    }
    const existing = await this.getStoredSettings();
    const previous = existing?.vault[service.id] ?? {};
    const apiKey = input.apiKey?.trim() || previous.apiKey || null;
    const baseUrl =
      (input.baseUrl ?? '').trim() || previous.baseUrl || service.baseUrl || null;
    const systemPrompt = userComplement(input.systemPrompt) || existing?.systemPrompt || null;
    const vault: Vault = {
      ...(existing?.vault ?? {}),
      [service.id]: { apiKey, baseUrl, model },
    };
    const next: StoredAiSettings = {
      service: service.id,
      model,
      apiKey,
      baseUrl,
      systemPrompt,
      vault,
    };
    if (!this.isServiceConfigured(service, next)) {
      throw new BadRequestException(
        service.id === 'openai_compat'
          ? 'Indique URL base y clave API'
          : `Indique la clave API de ${service.label}`,
      );
    }
    await this.prisma.aiSettings.upsert({
      where: { slot: 'default' },
      create: {
        slot: 'default',
        service: next.service,
        model: next.model,
        apiKey: next.apiKey,
        baseUrl: next.baseUrl,
        vault,
        systemPrompt: next.systemPrompt,
      },
      update: {
        service: next.service,
        model: next.model,
        apiKey: next.apiKey,
        baseUrl: next.baseUrl,
        vault,
        systemPrompt: next.systemPrompt,
      },
    });
    return this.getSettings();
  }

  async ask(
    question: string,
    providerInput?: string,
    modelInput?: string,
    tenantInput?: string,
    history: Array<{ role: string; text: string }> = [],
  ) {
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
    const tenantId = this.sanitize(tenantInput);
    const prior = history
      .map((item) => `${item.role === 'assistant' ? 'asistente' : 'usuario'}: ${item.text}`)
      .join('\n');
    const corpus = [prior, trimmed].filter(Boolean).join('\n');
    const { facts, snapshot } = await this.investigationContext(corpus, tenantId);
    const askText = prior
      ? `${trimmed}\n\nHilo reciente:\n${prior}`
      : trimmed;
    const result = await this.callHolmes(askText, facts, model, stored?.systemPrompt);
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

  async snapshot(
    agentIdInput?: string | null,
    tenantInput?: string | null,
    scope: FactScope = this.fullScope(),
    question = '',
  ): Promise<HostSnapshot | null> {
    const agentId = (agentIdInput ?? '').trim().replace(/"/g, '');
    if (!agentId) {
      return null;
    }
    const tenantId = this.sanitize(tenantInput ?? undefined);
    try {
      const sel = `{agent_id="${agentId}"}`;
      const netSel = `{agent_id="${agentId}",device!="lo"}`;
      const cpuQuery = `1 - sum(rate(system_cpu_time_seconds_total${sel.replace('}', ',state="idle"}')}[5m])) / sum(rate(system_cpu_time_seconds_total${sel}[5m]))`;
      const [
        identity,
        cpus,
        cpu,
        cpuStates,
        load1,
        load5,
        load15,
        memUsed,
        memTotal,
        diskUsed,
        diskTotal,
        netIo,
        netErr,
        netDrop,
        uptime,
        uptimeAlt,
        modules,
        cpuSeries,
      ] = await Promise.all([
          this.promInstant(`ekms_agent_identity${sel}`),
          this.promInstant(`system_cpu_logical_count${sel}`),
          this.promInstant(cpuQuery),
          this.promInstant(
            `sum by (state) (rate(system_cpu_time_seconds_total${sel}[5m]))`,
          ),
          this.promInstant(`system_cpu_load_average_1m${sel}`),
          this.promInstant(`system_cpu_load_average_5m${sel}`),
          this.promInstant(`system_cpu_load_average_15m${sel}`),
          this.promInstant(`sum(system_memory_usage_bytes${sel.replace('}', ',state="used"}')})`),
          this.promInstant(`sum(system_memory_usage_bytes${sel})`),
          this.promInstant(
            `sum(system_filesystem_usage_bytes{agent_id="${agentId}",mountpoint="/",state="used"})`,
          ),
          this.promInstant(
            `sum(system_filesystem_usage_bytes{agent_id="${agentId}",mountpoint="/"})`,
          ),
          this.promInstant(
            `sum by (direction) (rate(system_network_io_bytes_total${netSel}[5m]))`,
          ),
          this.promInstant(`sum(rate(system_network_errors_total${netSel}[5m]))`),
          this.promInstant(`sum(rate(system_network_dropped_total${netSel}[5m]))`),
          this.promInstant(`max(system_uptime${sel})`),
          this.promInstant(`max(system_uptime_seconds${sel})`),
          this.promInstant(`ekms_agent_module_enabled${sel}`),
          scope.forecast || scope.hourStats || scope.dayStats
            ? this.promRange(cpuQuery, scope.dayStats ? 86400 : 3600, scope.dayStats ? 120 : 60)
            : Promise.resolve([] as Array<[number, number]>),
        ]);
      const ident = identity[0]?.metric ?? {};
      if (tenantId && ident.tenant_id && ident.tenant_id !== tenantId) {
        return null;
      }
      const finite = (value: number | undefined) =>
        value !== undefined && Number.isFinite(value) ? value : null;
      const cpuHostPercent =
        finite(cpu[0]?.value) === null ? null : (cpu[0].value as number) * 100;
      const memoryUsedBytes = finite(memUsed[0]?.value);
      const memoryTotalBytes = finite(memTotal[0]?.value);
      const memoryUsedPercent =
        memoryUsedBytes !== null && memoryTotalBytes !== null && memoryTotalBytes > 0
          ? (memoryUsedBytes / memoryTotalBytes) * 100
          : null;
      const byDirection = (direction: string) =>
        finite(netIo.find((row) => row.metric.direction === direction)?.value);
      const cpuStateTotal = cpuStates.reduce(
        (sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0),
        0,
      );
      const cpuByState = cpuStates
        .filter((row) => row.metric.state && Number.isFinite(row.value) && cpuStateTotal > 0)
        .map((row) => ({
          state: row.metric.state,
          percent: (row.value / cpuStateTotal) * 100,
        }));
      const forecast = this.forecastCpu(cpuHostPercent, cpuSeries);
      const stats = this.cpuStats(cpuSeries, this.extractCpuPercent(question));
      const logs =
        scope.logs || scope.dayStats
          ? await this.lokiLines(stats.maxAt ?? undefined)
          : { source: '', lines: [] as string[] };
      const host = {
        agentId: ident.agent_id ?? agentId,
        found: identity.length > 0 || cpus.length > 0 || memoryTotalBytes !== null,
        tenantId: ident.tenant_id ?? null,
        siteId: ident.site_id ?? null,
        mode: ident.mode ?? null,
        cpus: finite(cpus[0]?.value),
        cpuHostPercent,
        cpuByState,
        load1m: finite(load1[0]?.value),
        load5m: finite(load5[0]?.value),
        load15m: finite(load15[0]?.value),
        memoryUsedPercent,
        memoryUsedBytes,
        memoryTotalBytes,
        diskUsedBytes: finite(diskUsed[0]?.value),
        diskTotalBytes: finite(diskTotal[0]?.value),
        networkReceiveBps: byDirection('receive'),
        networkTransmitBps: byDirection('transmit'),
        networkErrorsPerSec: finite(netErr[0]?.value),
        networkDropsPerSec: finite(netDrop[0]?.value),
        uptimeSeconds: finite(uptime[0]?.value) ?? finite(uptimeAlt[0]?.value),
        modules: modules
          .filter((row) => row.value === 1 && row.metric.module)
          .map((row) => row.metric.module),
        logs,
        forecast,
        traces: {
          available: false,
          note: 'Trazas no disponibles.',
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
      const vault = this.parseVault(row.vault);
      if (row.service && !vault[row.service] && (row.apiKey || row.baseUrl)) {
        vault[row.service] = {
          apiKey: row.apiKey,
          baseUrl: row.baseUrl,
          model: row.model,
        };
      }
      return {
        service: row.service,
        model: row.model,
        apiKey: row.apiKey,
        baseUrl: row.baseUrl,
        systemPrompt: row.systemPrompt,
        vault,
      };
    } catch {
      return null;
    }
  }

  private parseVault(value: unknown): Vault {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    const vault: Vault = {};
    for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const item = entry as VaultEntry;
      vault[id] = {
        apiKey: item.apiKey ?? null,
        baseUrl: item.baseUrl ?? null,
        model: item.model ?? null,
      };
    }
    return vault;
  }

  private async probeActive(
    service: AiServiceDef,
    stored: StoredAiSettings | null,
    model: string,
  ): Promise<{ reachable: boolean; modelReady: boolean; online: boolean; detail: string }> {
    if (!this.isServiceConfigured(service, stored)) {
      return {
        reachable: false,
        modelReady: false,
        online: false,
        detail: 'Falta configurar el servicio',
      };
    }
    try {
      const probe =
        service.id === 'ollama'
          ? await this.probeOllama(model)
          : await this.probeCloud(service, stored);
      return { ...probe, online: probe.reachable && probe.modelReady };
    } catch {
      return {
        reachable: false,
        modelReady: false,
        online: false,
        detail: 'El servicio no responde',
      };
    }
  }

  private async probeOllama(model: string) {
    const creds = this.resolveCredentials(findService('ollama') ?? AI_SERVICES[0], null);
    const root = (creds.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/v1$/, '');
    const response = await fetch(`${root}/api/tags`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      return { reachable: false, modelReady: false, detail: 'El modelo local no responde' };
    }
    const body = (await response.json().catch(() => ({}))) as {
      models?: Array<{ name?: string }>;
    };
    const names = (body.models ?? []).map((item) => item.name ?? '');
    const ready = names.some(
      (name) => name === model || name.startsWith(`${model}`) || name.split(':')[0] === model.split(':')[0],
    );
    return {
      reachable: true,
      modelReady: ready,
      detail: ready ? 'Modelo disponible' : `Falta descargar ${model}`,
    };
  }

  private async probeCloud(service: AiServiceDef, stored: StoredAiSettings | null) {
    const creds = this.resolveCredentials(service, stored);
    if (service.transport === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': creds.apiKey ?? '',
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(5000),
      });
      return {
        reachable: response.ok,
        modelReady: response.ok,
        detail: response.ok ? 'API activa' : 'La API no responde o la clave no es válida',
      };
    }
    const base = (creds.baseUrl ?? '').replace(/\/$/, '');
    if (!base) {
      return { reachable: false, modelReady: false, detail: 'Falta la URL del modelo' };
    }
    const response = await fetch(`${base}/models`, {
      headers: creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    return {
      reachable: response.ok,
      modelReady: response.ok,
      detail: response.ok ? 'API activa' : 'La API no responde o la clave no es válida',
    };
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
    const request = this.sanitizeUpstreamPayload(payload, model);
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {}),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(180_000),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new ServiceUnavailableException(this.providerErrorMessage(body, response.status));
    }
    return body;
  }

  private sanitizeUpstreamPayload(
    payload: Record<string, unknown>,
    model: string,
  ): Record<string, unknown> {
    const request: Record<string, unknown> = { model, stream: false };
    const keys = [
      'messages',
      'tools',
      'tool_choice',
      'max_tokens',
      'max_completion_tokens',
      'stop',
      'n',
      'user',
      'response_format',
    ] as const;
    for (const key of keys) {
      if (payload[key] !== undefined) {
        request[key] = payload[key];
      }
    }
    if (Array.isArray(request.tools) && request.tools.length === 0) {
      delete request.tools;
      delete request.tool_choice;
    }
    if (!this.rejectsSampling(model)) {
      if (payload.temperature !== undefined) {
        request.temperature = payload.temperature;
      }
      if (payload.top_p !== undefined) {
        request.top_p = payload.top_p;
      }
    }
    return request;
  }

  private rejectsSampling(model: string): boolean {
    return /^grok-4(\.|$|-)/i.test(model);
  }

  private providerErrorMessage(body: Record<string, unknown>, status: number): string {
    const err = body.error;
    if (typeof err === 'string' && err.trim()) {
      return err.trim();
    }
    if (err && typeof err === 'object') {
      const message = (err as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message.trim();
      }
    }
    if (typeof body.message === 'string' && body.message.trim()) {
      return body.message.trim();
    }
    return `El modelo respondio ${status}`;
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
    const saved = stored?.vault[service.id];
    return {
      apiKey: saved?.apiKey?.trim() || this.firstKey(service.keyEnv),
      baseUrl: (
        saved?.baseUrl ||
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
        return 'qwen3.5:4b';
      case 'openai':
        return this.config.get<string>('OPENAI_MODEL')?.trim() || 'gpt-5.6';
      case 'anthropic':
        return this.config.get<string>('ANTHROPIC_MODEL')?.trim() || 'claude-sonnet-5';
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

  private async investigationContext(
    question: string,
    tenantId?: string,
  ): Promise<{
    facts: string;
    snapshot: HostSnapshot | null;
  }> {
    const scope = this.questionScope(question);
    const agents = await this.listConnectedAgents(tenantId);
    const named = this.extractAgentId(question, agents);
    const needsHost =
      scope.cpu ||
      scope.load ||
      scope.memory ||
      scope.network ||
      scope.logs ||
      scope.traces;
    const targetIds = named
      ? [named]
      : needsHost
        ? agents.slice(0, 5).map((item) => item.agentId)
        : [];
    const snapshots = (
      await Promise.all(targetIds.map((id) => this.snapshot(id, tenantId, scope, question)))
    ).filter((item): item is HostSnapshot => Boolean(item));
    return {
      facts: this.contextFacts(agents, snapshots, scope, Boolean(named)),
      snapshot: snapshots[0] ?? null,
    };
  }

  private async listConnectedAgents(tenantId?: string): Promise<
    Array<{ agentId: string; tenantId: string | null; siteId: string | null }>
  > {
    try {
      const selector = tenantId ? `{tenant_id="${tenantId}"}` : '';
      const rows = await this.promInstant(`ekms_agent_identity${selector}`);
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
    scope: FactScope,
    namedHost: boolean,
  ): string {
    const lines = [
      'Ficha medida. Usa estos numeros. No los contradigas.',
      'Responde solo la pregunta. No listes toda la ficha.',
      'Si el dato pedido no esta, di que no hay medicion. No hables de integraciones.',
      'Si los valores estan en rango normal, no inventes un incidente.',
    ];
    if (!namedHost) {
      lines.push(`agentes_conectados=${agents.length}`);
      if (!agents.length) {
        lines.push('Ningun agente esta reportando ahora.');
      } else {
        for (const agent of agents) {
          lines.push(
            `- agent_id=${agent.agentId} tenant=${agent.tenantId ?? 'sin datos'} site=${agent.siteId ?? 'sin datos'}`,
          );
        }
      }
    }
    for (const snapshot of snapshots) {
      const host = this.factsText(snapshot, scope);
      if (host) {
        lines.push('', host);
      }
    }
    return lines.join('\n');
  }

  private fullScope(): FactScope {
    return {
      cpu: true,
      load: true,
      memory: true,
      network: true,
      logs: true,
      traces: false,
      forecast: true,
      hourStats: true,
      dayStats: true,
    };
  }

  private questionScope(question: string): FactScope {
    const q = question.toLowerCase();
    const logs = /\b(logs?|registros?|eventos?|journal|syslog)\b/.test(q);
    const traces = /\b(trazas?|transacci[oó]n(?:es)?)\b/.test(q);
    const forecast = /\b(proyecci[oó]n|pron[oó]stico|tendencia)\b/.test(q);
    const hourStats = /\b(1\s*h|una hora|[uú]ltima hora|60\s*min)\b/.test(q);
    const investigate =
      /\b(qu[eé]\s+pas[oó]|cuando|entonces|investiga|llegamos|ese pico|aquel pico)\b/.test(
        q,
      ) || /\d{1,3}(?:[.,]\d+)?\s*%/.test(q);
    const dayStats =
      investigate ||
      /\b(hoy|today|d[ií]a|24\s*h|pico|m[aá]ximo|maximo|peak)\b/.test(q);
    const listing = /\b(qu[eé] agentes|agentes tengo|agentes conectados)\b/.test(q);
    const host = !listing;
    return {
      cpu: host,
      load: host,
      memory: host,
      network: host,
      logs: logs || investigate,
      traces,
      forecast: forecast || hourStats,
      hourStats,
      dayStats,
    };
  }

  private extractAgentId(
    question: string,
    agents: Array<{ agentId: string }> = [],
  ): string | null {
    const labeled = question.match(/agent_id\s*[:=]\s*["']?([A-Za-z0-9._-]+)/i);
    if (labeled?.[1]) {
      return labeled[1];
    }
    const named = question.match(
      /\b(?:agente|host|servidor|nodo)\s+([A-Za-z0-9._-]+)/i,
    );
    if (named?.[1]) {
      return named[1];
    }
    const dashed = question.match(/\b(agent-[A-Za-z0-9._-]+|srv-[A-Za-z0-9._-]+)\b/i);
    if (dashed?.[1]) {
      return dashed[1];
    }
    const lower = question.toLowerCase();
    return agents.find((item) => lower.includes(item.agentId.toLowerCase()))?.agentId ?? null;
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

  private async lokiLines(atUnix?: number): Promise<{ source: string; lines: string[] }> {
    const source = '{service_name="ekumetrics-agent"}';
    try {
      const centerMs = (atUnix && atUnix > 1e9 ? atUnix * 1000 : Date.now());
      const windowMs = 15 * 60 * 1000;
      const end = (centerMs + windowMs) * 1_000_000;
      const start = (centerMs - windowMs) * 1_000_000;
      const url = `${this.lokiUrl()}/loki/api/v1/query_range?${new URLSearchParams({
        query: source,
        start: String(start),
        end: String(end),
        limit: '20',
        direction: 'backward',
      }).toString()}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const body = (await response.json()) as {
        data?: { result?: Array<{ values?: Array<[string, string]> }> };
      };
      const lines = (body.data?.result ?? [])
        .flatMap((stream) => stream.values ?? [])
        .slice(0, 20)
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
      mode: null,
      cpus: null,
      cpuHostPercent: null,
      cpuByState: [],
      load1m: null,
      load5m: null,
      load15m: null,
      memoryUsedPercent: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      diskUsedBytes: null,
      diskTotalBytes: null,
      networkReceiveBps: null,
      networkTransmitBps: null,
      networkErrorsPerSec: null,
      networkDropsPerSec: null,
      uptimeSeconds: null,
      modules: [],
      logs: { source: '{service_name="ekumetrics-agent"}', lines: [] },
      forecast: {
        method: 'linear-15m',
        cpuHostNow: null,
        cpuHostIn15m: null,
        note: 'Sin serie para proyectar.',
      },
      assessment: {
        verdict: 'anomaly',
        findings: ['El agente no reporta metricas.'],
        cpuAvg1h: null,
        cpuMax1h: null,
        cpuMaxAt: null,
      },
      traces: {
        available: false,
        note: 'Trazas no disponibles.',
      },
    };
  }

  private cpuStats(
    series: Array<[number, number]>,
    target?: number | null,
  ): {
    avg: number | null;
    max: number | null;
    maxAt: number | null;
  } {
    let max = Number.NEGATIVE_INFINITY;
    let maxAt: number | null = null;
    let match = Number.NEGATIVE_INFINITY;
    let matchAt: number | null = null;
    let matchDiff = Number.POSITIVE_INFINITY;
    let sum = 0;
    let count = 0;
    for (const [ts, raw] of series) {
      const value = raw * 100;
      if (!Number.isFinite(value)) {
        continue;
      }
      count += 1;
      sum += value;
      if (value > max) {
        max = value;
        maxAt = ts;
      }
      if (target != null) {
        const diff = Math.abs(value - target);
        if (diff < matchDiff) {
          matchDiff = diff;
          match = value;
          matchAt = ts;
        }
      }
    }
    if (!count) {
      return { avg: null, max: null, maxAt: null };
    }
    if (target != null && matchAt != null && matchDiff <= 1.5) {
      return { avg: sum / count, max: match, maxAt: matchAt };
    }
    return { avg: sum / count, max, maxAt };
  }

  private extractCpuPercent(text: string): number | null {
    const labeled = text.match(/(\d{1,3}(?:[.,]\d+)?)\s*%/);
    const nearCpu = text.match(
      /(?:cpu\D{0,24})(\d{1,3}(?:[.,]\d+))|(\d{1,3}(?:[.,]\d+))\s*(?:de\s+)?cpu/i,
    );
    const raw = labeled?.[1] ?? nearCpu?.[1] ?? nearCpu?.[2];
    if (!raw) {
      return null;
    }
    const value = Number(raw.replace(',', '.'));
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  }

  private assessHost(
    host: Omit<HostSnapshot, 'assessment'>,
    stats: { avg: number | null; max: number | null; maxAt: number | null },
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
        findings: ['Sin series de este agente.'],
        cpuAvg1h: stats.avg,
        cpuMax1h: stats.max,
        cpuMaxAt: stats.maxAt,
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
      findings.push('Los valores medidos estan en rango normal.');
    }
    return {
      verdict,
      findings,
      cpuAvg1h: stats.avg,
      cpuMax1h: stats.max,
      cpuMaxAt: stats.maxAt,
    };
  }

  private investigatorPrompt(custom?: string | null): string {
    return composeInvestigatorPrompt(custom);
  }

  private composeAnalysis(_snapshot: HostSnapshot | null, explanation: string): string {
    return sanitizeAssistantReply(explanation);
  }

  private formatGib(bytes: number | null): string {
    if (bytes === null || !Number.isFinite(bytes) || bytes < 0) {
      return 'sin datos';
    }
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  }

  private formatRate(bytesPerSec: number | null): string {
    if (bytesPerSec === null || !Number.isFinite(bytesPerSec) || bytesPerSec < 0) {
      return 'sin datos';
    }
    if (bytesPerSec >= 1024 ** 2) {
      return `${(bytesPerSec / 1024 ** 2).toFixed(2)} MiB/s`;
    }
    if (bytesPerSec >= 1024) {
      return `${(bytesPerSec / 1024).toFixed(2)} KiB/s`;
    }
    return `${bytesPerSec.toFixed(2)} B/s`;
  }

  private formatPerSec(value: number | null): string {
    if (value === null || !Number.isFinite(value) || value < 0) {
      return 'sin datos';
    }
    return `${value.toFixed(2)} /s`;
  }

  private formatDuration(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
      return 'sin datos';
    }
    const total = Math.floor(seconds);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0) {
      return `${days}d ${hours}h`;
    }
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  private formatPeakTime(unix?: number | null): string {
    if (!unix || !Number.isFinite(unix)) {
      return 'sin datos';
    }
    const ms = unix > 1e12 ? unix : unix * 1000;
    return new Date(ms).toLocaleString('es', {
      dateStyle: 'short',
      timeStyle: 'medium',
    });
  }

  private factsText(snapshot: HostSnapshot | null, scope: FactScope): string {
    if (!snapshot?.found) {
      return '';
    }
    const pct = (n: number | null) => (n === null ? 'sin datos' : `${n.toFixed(2)}%`);
    const num = (n: number | null, digits = 2) =>
      n === null ? 'sin datos' : n.toFixed(digits);
    const diskPercent =
      snapshot.diskUsedBytes !== null &&
      snapshot.diskTotalBytes !== null &&
      snapshot.diskTotalBytes > 0
        ? (snapshot.diskUsedBytes / snapshot.diskTotalBytes) * 100
        : null;
    const lines = [`agent_id=${snapshot.agentId}`];
    if (snapshot.mode) {
      lines.push(`modo=${snapshot.mode}`);
    }
    if (scope.cpu) {
      lines.push(`cpus=${num(snapshot.cpus, 0)}`, `cpu_host=${pct(snapshot.cpuHostPercent)}`);
      for (const item of snapshot.cpuByState) {
        lines.push(`cpu_${item.state}=${item.percent.toFixed(2)}%`);
      }
    }
    if (scope.load) {
      lines.push(
        `load_1m=${num(snapshot.load1m)}`,
        `load_5m=${num(snapshot.load5m)}`,
        `load_15m=${num(snapshot.load15m)}`,
      );
    }
    if (scope.memory) {
      lines.push(
        `memoria_total=${this.formatGib(snapshot.memoryTotalBytes)}`,
        `memoria_usada=${this.formatGib(snapshot.memoryUsedBytes)} (${pct(snapshot.memoryUsedPercent)})`,
      );
    }
    if (scope.cpu || scope.memory) {
      lines.push(
        `disco_raiz_total=${this.formatGib(snapshot.diskTotalBytes)}`,
        `disco_raiz_usado=${this.formatGib(snapshot.diskUsedBytes)} (${pct(diskPercent)})`,
        `uptime=${this.formatDuration(snapshot.uptimeSeconds)}`,
        `modulos=${snapshot.modules.length ? snapshot.modules.join(', ') : 'sin datos'}`,
      );
    }
    if (scope.network) {
      lines.push(
        `red_rx=${this.formatRate(snapshot.networkReceiveBps)}`,
        `red_tx=${this.formatRate(snapshot.networkTransmitBps)}`,
        `red_errores=${this.formatPerSec(snapshot.networkErrorsPerSec)}`,
        `red_descartes=${this.formatPerSec(snapshot.networkDropsPerSec)}`,
      );
    }
    if (scope.dayStats) {
      lines.push(
        `cpu_media_24h=${pct(snapshot.assessment.cpuAvg1h)}`,
        `cpu_max_24h=${pct(snapshot.assessment.cpuMax1h)}`,
        `cpu_max_en=${this.formatPeakTime(snapshot.assessment.cpuMaxAt)}`,
        'ventana_cpu=ultimas 24h o desde que hay muestras',
      );
    } else if (scope.hourStats) {
      lines.push(
        `cpu_media_1h=${pct(snapshot.assessment.cpuAvg1h)}`,
        `cpu_max_1h=${pct(snapshot.assessment.cpuMax1h)}`,
      );
    }
    if (scope.forecast) {
      lines.push(
        `cpu_host_en_15m=${pct(snapshot.forecast.cpuHostIn15m)} (${snapshot.forecast.note})`,
      );
    }
    if (scope.cpu || scope.load || scope.memory) {
      for (const item of snapshot.assessment.findings) {
        lines.push(`- ${item}`);
      }
    }
    if (scope.logs) {
      lines.push(
        `registros=${snapshot.logs.lines.length} lineas alrededor de ${this.formatPeakTime(snapshot.assessment.cpuMaxAt)}`,
        'Los registros no contienen el porcentaje de CPU. No busques ese numero ahi.',
      );
      for (const line of snapshot.logs.lines) {
        lines.push(`- ${line}`);
      }
    }
    if (scope.traces) {
      lines.push(
        `trazas=${snapshot.traces.available ? 'si' : 'no'}. ${snapshot.traces.note}`,
      );
    }
    return lines.join('\n');
  }

  private async callHolmes(question: string, facts: string, model: string, customPrompt?: string | null) {
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
          additional_system_prompt: this.investigatorPrompt(customPrompt),
        }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      throw new ServiceUnavailableException(
        'El asistente no responde. El modelo local no está disponible.',
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
    const system = this.investigatorPrompt(stored?.systemPrompt);
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
        ...(this.rejectsSampling(model) ? {} : { temperature: 0.1 }),
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

  private sanitize(value?: string): string {
    return (value ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '');
  }
}
