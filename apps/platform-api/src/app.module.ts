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
import { IncidentsModule } from './aiops/incidents.module';
import { TenantsModule } from './tenants/tenants.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
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
  ],
})
export class AppModule {}
