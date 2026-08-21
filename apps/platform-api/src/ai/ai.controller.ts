import { Body, Controller, Get, Headers, Post, Put, Query } from '@nestjs/common';
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
  snapshot(@Query('agent_id') agentId?: string) {
    return this.ai.snapshot(agentId);
  }

  @Post('ask')
  ask(@Body() body: AskBody) {
    return this.ai.ask(body.question ?? '', body.service ?? body.provider, body.model);
  }

  @Post('upstream/chat/completions')
  upstream(
    @Body() body: Record<string, unknown>,
    @Headers('authorization') authorization?: string,
  ) {
    return this.ai.upstreamCompletions(body, authorization);
  }
}
