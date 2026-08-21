jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from './ai.service';

describe('AiService', () => {
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
  });

  it('guarda ollama en settings sin clave', async () => {
    prisma.aiSettings.upsert.mockResolvedValue({
      service: 'ollama',
      model: 'qwen2.5:14b',
      apiKey: null,
      baseUrl: null,
    });
    const saved = await service().saveSettings({
      service: 'ollama',
      model: 'qwen2.5:14b',
    });
    expect(saved.hasApiKey).toBe(false);
    expect(saved.service).toBe('ollama');
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
