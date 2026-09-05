import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from './ai/ai.module';
import { AlertmanagerModule } from './alertmanager/alertmanager.module';
import { BoardsModule } from './boards/boards.module';
import { AuthModule } from './auth/auth.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthModule } from './health/health.module';
import { IngestModule } from './ingest/ingest.module';
import { ObservabilityModule } from './observability/observability.module';
import { PrismaModule } from './prisma/prisma.module';
import { AnomalyModule } from './aiops/anomaly/anomaly.module';
import { AiopsDomainModule } from './aiops/aiops-domain.module';
import { HistoricalModule } from './aiops/historical/historical.module';
import { IncidentsModule } from './aiops/incidents.module';
import { InvestigationModule } from './aiops/investigation/investigation.module';
import { MessagingModule } from './messaging/messaging.module';
import { TenantsModule } from './tenants/tenants.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    MessagingModule,
    AuthModule,
    HealthModule,
    IngestModule,
    ObservabilityModule,
    DashboardModule,
    BoardsModule,
    TenantsModule,
    AiModule,
    AlertmanagerModule,
    IncidentsModule,
    InvestigationModule,
    AiopsDomainModule,
    AnomalyModule,
    HistoricalModule,
  ],
})
export class AppModule {}
