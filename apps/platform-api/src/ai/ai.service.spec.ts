jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from './ai.service';

describe('AiService', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const prisma = {
    aiInquiry: { create: jest.fn() },
    aiSettings: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
    },
  };

  const service = (env: Record<string, string> = {}) =>
    new AiService(
      {
        get: (key: string) => env[key],
      } as ConfigService,
      prisma as never,
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
      json: async () => ({ models: [{ name: 'qwen3.5:4b' }] }),
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
      vault: { openai: { apiKey: 'sk-old', model: 'gpt-5.6' }, ollama: { model: 'qwen3.5:4b' } },
    };
    prisma.aiSettings.findUnique.mockResolvedValueOnce(previous).mockResolvedValue(savedRow);
    prisma.aiSettings.upsert.mockResolvedValue(savedRow);
    const saved = await service().saveSettings({
      service: 'ollama',
      model: 'qwen3.5:4b',
    });
    expect(saved.hasApiKey).toBe(false);
    expect(saved.service).toBe('ollama');
    const vault = prisma.aiSettings.upsert.mock.calls.at(-1)?.[0].update.vault as {
      openai?: { apiKey?: string };
    };
    expect(vault.openai?.apiKey).toBe('sk-old');
  });

  it('rechaza openai en settings sin clave', async () => {
    await expect(
      service().saveSettings({ service: 'openai', model: 'gpt-4.1-mini' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza pregunta vacia', async () => {
    await expect(service().ask('   ')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza openai sin API key', async () => {
    await expect(service().ask('cpu alta', 'openai')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
