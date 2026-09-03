import { Module } from '@nestjs/common';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AiController } from './ai.controller';
import { AiRetentionService } from './ai-retention.service';
import { RetrievalService } from './retrieval.service';
import { AiService } from './ai.service';
import { KnowledgeService } from './knowledge.service';

@Module({
  imports: [DashboardModule],
  controllers: [AiController],
  providers: [
    AiService,
    AiRetentionService,
    RetrievalService,
    KnowledgeService,
  ],
})
export class AiModule {}
