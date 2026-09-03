import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { actingTenant } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user';
import type { AuthUser } from '../auth/auth.types';
import { Public } from '../auth/public';
import { Roles } from '../auth/roles';
import { AuditAction } from '../auth/audit-action';
import { AiService } from './ai.service';
import {
  KnowledgeService,
  type KnowledgeDocumentInput,
} from './knowledge.service';

type AskBody = {
  question?: string;
  provider?: string;
  service?: string;
  model?: string;
  history?: Array<{ role?: string; text?: string }>;
  conversationId?: string;
};

type ConversationBody = { title?: string };

type SettingsBody = {
  service?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  systemPrompt?: string;
};

@Controller('v1/ai')
@Roles('operator', 'admin', 'viewer')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly knowledge: KnowledgeService,
  ) {}

  @Get('status')
  status() {
    return this.ai.status();
  }

  @Get('settings')
  @Roles('operator')
  settings() {
    return this.ai.getSettings();
  }

  @Put('settings')
  @Roles('operator')
  @AuditAction('ai.settings.updated', 'ai_settings')
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

  @Get('conversations')
  conversations(
    @CurrentUser() user: AuthUser,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.ai.listConversations(
      actingTenant(user, headerSlug),
      user.email,
    );
  }

  @Post('conversations')
  createConversation(
    @CurrentUser() user: AuthUser,
    @Body() body: ConversationBody,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.ai.createConversation(
      actingTenant(user, headerSlug),
      user.email,
      body.title,
    );
  }

  @Get('conversations/:id')
  conversation(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.ai.getConversation(
      id,
      actingTenant(user, headerSlug),
      user.email,
    );
  }

  @Delete('conversations/:id')
  @AuditAction('ai.conversation.deleted', 'ai_conversation')
  deleteConversation(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.ai.deleteConversation(
      id,
      actingTenant(user, headerSlug),
      user.email,
    );
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
      user.email,
      body.conversationId,
    );
  }

  @Post('knowledge/documents')
  @Roles('operator', 'admin')
  @AuditAction('ai.knowledge.upserted', 'ai_knowledge_document')
  upsertKnowledge(
    @CurrentUser() user: AuthUser,
    @Body() body: KnowledgeDocumentInput,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.knowledge.upsertDocument(
      actingTenant(user, headerSlug),
      user.email,
      body,
    );
  }

  @Get('knowledge/documents')
  @Roles('operator', 'admin')
  knowledgeDocuments(
    @CurrentUser() user: AuthUser,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.knowledge.listDocuments(
      actingTenant(user, headerSlug),
      user.email,
    );
  }

  @Delete('knowledge/documents/:id')
  @Roles('operator', 'admin')
  @AuditAction('ai.knowledge.deleted', 'ai_knowledge_document')
  deleteKnowledge(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.knowledge.deleteDocument(
      actingTenant(user, headerSlug),
      user.email,
      id,
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
