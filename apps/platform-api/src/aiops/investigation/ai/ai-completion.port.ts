import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { findService } from '../../../ai/ai.catalog';
import type { InvestigationPrivacyMode } from '../../types/investigation-policy';
import { redactSecrets } from '../../types/tool-call';

export type AiCompletionRequest = {
  prompt: string;
  privacyMode: InvestigationPrivacyMode;
  maxTokens: number;
};

export type AiCompletionResponse = {
  text: string;
  provider: string;
  model: string;
  redactionApplied: boolean;
};

@Injectable()
export class AiCompletionPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async complete(
    input: AiCompletionRequest,
  ): Promise<AiCompletionResponse | null> {
    if (input.privacyMode === 'AI_DISABLED') return null;
    const settings = await this.readSettings();
    if (!settings) return null;
    const service = findService(settings.service);
    if (!service) return null;
    const isLocal = service.transport === 'holmes' || service.id === 'ollama';
    if (input.privacyMode === 'LOCAL_ONLY' && !isLocal) return null;
    if (
      (input.privacyMode === 'CLOUD_REDACTED' ||
        input.privacyMode === 'CLOUD_ALLOWED') &&
      isLocal &&
      !settings.apiKey
    ) {
      // local still allowed
    }
    const prompt =
      input.privacyMode === 'CLOUD_ALLOWED'
        ? input.prompt.slice(0, 8_000)
        : redactSecrets(input.prompt, 8_000);
    try {
      if (isLocal) {
        const url = `${(this.config.get<string>('HOLMES_URL') ?? 'http://localhost:5050').replace(/\/$/, '')}/api/chat`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ask: prompt,
            model: settings.model.includes('/')
              ? settings.model
              : `openai/${settings.model}`,
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { analysis?: string };
        if (!body.analysis?.trim()) return null;
        return {
          text: body.analysis.trim(),
          provider: service.id,
          model: settings.model,
          redactionApplied: input.privacyMode !== 'CLOUD_ALLOWED',
        };
      }
      if (!settings.apiKey || !settings.baseUrl) return null;
      const response = await fetch(
        `${settings.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify({
            model: settings.model,
            max_tokens: Math.min(512, Math.max(64, input.maxTokens || 256)),
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = body.choices?.[0]?.message?.content?.trim();
      if (!text) return null;
      return {
        text,
        provider: service.id,
        model: settings.model,
        redactionApplied: input.privacyMode !== 'CLOUD_ALLOWED',
      };
    } catch {
      return null;
    }
  }

  private async readSettings(): Promise<{
    service: string;
    model: string;
    apiKey: string | null;
    baseUrl: string | null;
  } | null> {
    try {
      const row = await this.prisma.aiSettings.findUnique({
        where: { slot: 'default' },
      });
      if (!row) return null;
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
}
