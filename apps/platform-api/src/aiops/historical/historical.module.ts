import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../../observability/observability.module';
import { HISTORICAL_EVIDENCE } from './historical-evidence.port';
import { HistoricalController } from './historical.controller';
import { HISTORICAL_REPOSITORY } from './historical.repository';
import { HistoricalService } from './historical.service';
import { InMemoryHistoricalRepository } from './in-memory.historical.repository';
import { PrismaHistoricalRepository } from './prisma-historical.repository';

/**
 * Inteligencia histórica. Persistencia Prisma; in-memory queda para tests.
 * RcaEngine inyecta HISTORICAL_EVIDENCE. Sin Holmes / LLM / embeddings.
 */
@Module({
  imports: [ObservabilityModule],
  controllers: [HistoricalController],
  providers: [
    InMemoryHistoricalRepository,
    PrismaHistoricalRepository,
    {
      provide: HISTORICAL_REPOSITORY,
      useExisting: PrismaHistoricalRepository,
    },
    HistoricalService,
    {
      provide: HISTORICAL_EVIDENCE,
      useExisting: HistoricalService,
    },
  ],
  exports: [
    HistoricalService,
    HISTORICAL_EVIDENCE,
    HISTORICAL_REPOSITORY,
    PrismaHistoricalRepository,
    InMemoryHistoricalRepository,
  ],
})
export class HistoricalModule {}
