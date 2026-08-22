import { Body, Controller, Get, Headers, Post, Put, Query } from '@nestjs/common';
import { actingTenant } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user';
import type { AuthUser } from '../auth/auth.types';
import { Public } from '../auth/public';
import { AiService } from './ai.service';

type AskBody = {
  question?: string;
  provider?: string;
  service?: string;
  model?: string;
};

type SettingsBody = {
  service?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  systemPrompt?: string;
};

@Controller('v1/ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('status')
  status() {
    return this.ai.status();
  }

  @Get('settings')
  settings() {
    return this.ai.getSettings();
  }

  @Put('settings')
  saveSettings(@Body() body: SettingsBody) {
    return this.ai.saveSettings(body);
  }

  @Get('snapshot')
  snapshot(
    @CurrentUser() user: AuthUser,
    @Query('agent_id') agentId?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.ai.snapshot(agentId, actingTenant(user, headerSlug));
  }

  @Post('ask')
  ask(
    @CurrentUser() user: AuthUser,
    @Body() body: AskBody,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.ai.ask(
      body.question ?? '',
      body.service ?? body.provider,
      body.model,
      actingTenant(user, headerSlug),
    );
  }

  @Public()
  @Post('upstream/chat/completions')
  upstream(
    @Body() body: Record<string, unknown>,
    @Headers('authorization') authorization?: string,
  ) {
    return this.ai.upstreamCompletions(body, authorization);
  }
}
