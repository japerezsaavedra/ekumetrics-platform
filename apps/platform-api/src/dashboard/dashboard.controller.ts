import { Controller, Get, Query } from '@nestjs/common';
import { actingTenant } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user';
import type { AuthUser } from '../auth/auth.types';
import { DashboardService } from './dashboard.service';

@Controller('v1/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  getDashboard(
    @CurrentUser() user: AuthUser,
    @Query('host_id') hostId?: string,
    @Query('agent_id') agentId?: string,
    @Query('range') range?: string,
    @Query('tenant_id') tenantId?: string,
  ) {
    return this.dashboard.getDashboard(hostId || agentId, range, actingTenant(user, tenantId));
  }
}
