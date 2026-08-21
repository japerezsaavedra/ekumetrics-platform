import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { TelemetryClient } from './telemetry.client';

@Module({
  imports: [TenantsModule],
  controllers: [DashboardController],
  providers: [DashboardService, TelemetryClient],
})
export class DashboardModule {}
