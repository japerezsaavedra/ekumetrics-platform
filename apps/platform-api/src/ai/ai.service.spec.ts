jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from './ai.service';
import type { RetrievalEvidence } from './retrieval.service';

describe('AiService', () => {
  type SettingsUpsertInput = {
    update: { vault: { openai?: { apiKey?: string } } };
  };
  let lastUpsert: SettingsUpsertInput | undefined;
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    lastUpsert = undefined;
    prisma.aiSettings.findUnique.mockResolvedValue(null);
    prisma.tenant.findUnique.mockReset();
    prisma.agent.findUnique.mockReset();
    prisma.aiConversation.findMany.mockReset();
    prisma.aiConversation.findFirst.mockReset();
    prisma.aiConversation.create.mockReset();
    prisma.aiConversation.deleteMany.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({}),
    });
    global.fetch = fetchMock;
  });

  const prisma = {
    aiInquiry: { create: jest.fn() },
    tenant: { findUnique: jest.fn() },
    agent: { findUnique: jest.fn() },
    aiConversation: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
    aiSettings: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn<(input: SettingsUpsertInput) => Promise<unknown>>(),
      update: jest.fn(),
    },
  };
  const retrieval = {
    getHostHealth: jest.fn(),
    getComponentDependencies: jest.fn(),
    getAgentEvents: jest.fn(),
    getOpenIncidents: jest.fn(),
    findMetricAnomalies: jest.fn(),
  };

  const service = (env: Record<string, string> = {}) =>
    new AiService(
      {
        get: (key: string) =>
          env[key] ??
          (key === 'AI_SETTINGS_ENCRYPTION_KEY'
            ? 'test-only-encryption-key-with-at-least-32-characters'
            : undefined),
      } as ConfigService,
      prisma as never,
      retrieval as never,
    );

  it('marca ollama como configurado y openai no, sin clave', async () => {
    const status = await service().status();
    expect(status.defaultProvider).toBe('ollama');
    expect(status.defaultService).toBe('ollama');
    const openai = status.providers.find((p) => p.id === 'openai');
    expect(openai?.configured).toBe(false);
    const kimi = status.services.find((item) => item.id === 'kimi');
    expect(kimi?.configured).toBe(false);
    expect(kimi?.models).toContain('kimi-k3');
    expect(status.active.model).toBe('qwen3.5:4b');
    expect(status.active.online).toBe(false);
  });

  it('marca ollama activo cuando responde y tiene el modelo', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [{ name: 'qwen3.5:4b' }] }),
    });
    const status = await service().status();
    expect(status.active.online).toBe(true);
    expect(status.active.detail).toBe('Modelo disponible');
  });

  it('guarda ollama en settings sin clave', async () => {
    const previous = {
      service: 'openai',
      model: 'gpt-5.6',
      apiKey: 'sk-old',
      baseUrl: null,
      vault: { openai: { apiKey: 'sk-old', model: 'gpt-5.6' } },
    };
    const savedRow = {
      service: 'ollama',
      model: 'qwen3.5:4b',
      apiKey: null,
      baseUrl: null,
      vault: {
        openai: { apiKey: 'sk-old', model: 'gpt-5.6' },
        ollama: { model: 'qwen3.5:4b' },
      },
    };
    prisma.aiSettings.findUnique
      .mockResolvedValueOnce(previous)
      .mockResolvedValue(savedRow);
    prisma.aiSettings.upsert.mockImplementation(
      (input: SettingsUpsertInput) => {
        lastUpsert = input;
        return Promise.resolve(savedRow);
      },
    );
    const saved = await service().saveSettings({
      service: 'ollama',
      model: 'qwen3.5:4b',
    });
    expect(saved.hasApiKey).toBe(false);
    expect(saved.service).toBe('ollama');
    expect(lastUpsert?.update.vault.openai?.apiKey).toMatch(/^enc:v1:/);
  });

  it('rechaza openai en settings sin clave', async () => {
    await expect(
      service().saveSettings({ service: 'openai', model: 'gpt-4.1-mini' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails closed when provider credentials cannot be encrypted', async () => {
    await expect(
      service({ AI_SETTINGS_ENCRYPTION_KEY: '' }).saveSettings({
        service: 'openai',
        model: 'gpt-5.6',
        apiKey: 'sk-provider-secret',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.aiSettings.upsert).not.toHaveBeenCalled();
  });

  it('rechaza pregunta vacia', async () => {
    await expect(service().ask('   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('asigna citas estables por fuente sin exponer la consulta en la etiqueta', () => {
    const evidence = [
      {
        id: 'metric-1',
        source: 'prometheus',
        operation: 'get_host_health',
        window: {
          start: '2026-08-26T10:00:00.000Z',
          end: '2026-08-26T11:00:00.000Z',
        },
        summary: '1 resultado.',
        timestamp: '2026-08-26T11:00:00.000Z',
        resultCount: 1,
      },
      {
        id: 'metric-2',
        source: 'prometheus',
        operation: 'get_metric_series:cpu_used_ratio',
        window: {
          start: '2026-08-26T10:00:00.000Z',
          end: '2026-08-26T11:00:00.000Z',
        },
        summary: '10 resultados.',
        timestamp: '2026-08-26T11:00:00.000Z',
        resultCount: 10,
      },
      {
        id: 'trace-1',
        source: 'tempo',
        operation: 'search_traces',
        window: {
          start: '2026-08-26T10:00:00.000Z',
          end: '2026-08-26T11:00:00.000Z',
        },
        summary: '2 resultados.',
        timestamp: '2026-08-26T11:00:00.000Z',
        resultCount: 2,
      },
    ] satisfies RetrievalEvidence[];
    const internal = service() as unknown as {
      citeEvidence: (items: RetrievalEvidence[]) => RetrievalEvidence[];
    };

    expect(
      internal.citeEvidence(evidence).map((item) => item.citation),
    ).toEqual(['M1', 'M2', 'T1']);
  });

  it('distingue una fuente no disponible de una fuente sin datos', () => {
    const unavailable: RetrievalEvidence = {
      id: 'tempo:unavailable',
      source: 'tempo',
      operation: 'source_unavailable',
      window: {
        start: '2026-08-26T10:00:00.000Z',
        end: '2026-08-26T11:00:00.000Z',
      },
      summary: 'La fuente solicitada no estuvo disponible.',
      timestamp: '2026-08-26T11:00:00.000Z',
      resultCount: 0,
      available: false,
    };
    const internal = service() as unknown as {
      investigationSummary: (
        snapshot: null,
        scope: unknown,
        period: { start: Date; end: Date },
        evidence: RetrievalEvidence[],
      ) => {
        sources: Record<string, string>;
        confidence: { level: string };
        outcome: string;
      };
    };
    const period = {
      start: new Date('2026-08-26T10:00:00.000Z'),
      end: new Date('2026-08-26T11:00:00.000Z'),
    };

    const summary = internal.investigationSummary(
      null,
      { logs: false, traces: true },
      period,
      [unavailable],
    );

    expect(summary.sources.tempo).toBe('unavailable');
    expect(summary.confidence.level).toBe('low');
    expect(summary.outcome).toBe('no_data');
  });

  it('rechaza openai sin API key', async () => {
    await expect(service().ask('cpu alta', 'openai')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('aplica tenant, sitio y agente a todas las consultas de telemetria', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-db-a',
      slug: 'tenant-a',
    });
    prisma.agent.findUnique.mockResolvedValue({
      agentId: 'shared-agent',
      siteId: 'site-a',
      mode: 'site',
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'success', data: { result: [] } }),
    });

    const snapshot = await service().snapshot('shared-agent', 'tenant-a');

    expect(snapshot).toMatchObject({
      agentId: 'shared-agent',
      tenantId: 'tenant-a',
      siteId: 'site-a',
    });
    const telemetryUrls = fetchMock.mock.calls.map(([url]) =>
      decodeURIComponent(String(url)),
    );
    expect(telemetryUrls.length).toBeGreaterThan(1);
    for (const url of telemetryUrls) {
      expect(url).toContain('tenant_id="tenant-a"');
      expect(url).toContain('site_id="site-a"');
      expect(url).toContain('agent_id="shared-agent"');
    }
  });

  it('rechaza un agentId existente en otro tenant antes de consultar telemetria', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-db-b',
      slug: 'tenant-b',
    });
    prisma.agent.findUnique.mockResolvedValue(null);

    await expect(
      service().snapshot('shared-agent', 'tenant-b'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.agent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_agentId: {
            tenantId: 'tenant-db-b',
            agentId: 'shared-agent',
          },
        },
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reporta Prometheus caido y no lo presenta como snapshot vacio', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-db-a',
      slug: 'tenant-a',
    });
    prisma.agent.findUnique.mockResolvedValue({
      agentId: 'agent-a',
      siteId: 'site-a',
      mode: 'site',
    });
    fetchMock.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ status: 'error' }),
    });

    await expect(
      service().snapshot('agent-a', 'tenant-a'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('lista conversaciones solo para la combinacion tenant y actor', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-db-a',
      slug: 'tenant-a',
    });
    prisma.aiConversation.findMany.mockResolvedValue([
      {
        id: 'conversation-1',
        title: 'CPU alta',
        updatedAt: new Date('2026-08-26T20:00:00.000Z'),
        _count: { inquiries: 2 },
      },
    ]);

    await expect(
      service().listConversations('tenant-a', 'USER@EXAMPLE.COM'),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'conversation-1', questionCount: 2 }),
    ]);
    expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-db-a', actor: 'user@example.com' },
      }),
    );
  });

  it('el borrado queda acotado por tenant, actor e id', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-db-a',
      slug: 'tenant-a',
    });
    prisma.aiConversation.deleteMany.mockResolvedValue({ count: 0 });

    await expect(
      service().deleteConversation(
        'conversation-foreign',
        'tenant-a',
        'user@example.com',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.aiConversation.deleteMany).toHaveBeenCalledWith({
      where: {
        id: 'conversation-foreign',
        tenantId: 'tenant-db-a',
        actor: 'user@example.com',
      },
    });
  });
});
