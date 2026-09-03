import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { PlatformController } from '../platform/platform.controller';
import { PlatformService } from '../platform/platform.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { TelemetryClient } from './telemetry.client';

@Module({
  imports: [TenantsModule],
  controllers: [DashboardController, PlatformController],
  providers: [DashboardService, PlatformService, TelemetryClient],
  exports: [DashboardService, TelemetryClient],
})
export class DashboardModule {}
