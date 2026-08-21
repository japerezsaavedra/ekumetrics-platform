import { Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';

@Controller('v1/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  getDashboard(
    @Query('host_id') hostId?: string,
    @Query('agent_id') agentId?: string,
    @Query('range') range?: string,
    @Query('tenant_id') tenantId?: string,
  ) {
    return this.dashboard.getDashboard(hostId || agentId, range, tenantId);
  }
}
