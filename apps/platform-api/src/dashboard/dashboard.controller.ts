import { Controller, Get, Query } from '@nestjs/common';
import { actingTenant } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user';
import type { AuthUser } from '../auth/auth.types';
import { AllowKiosk } from '../auth/allow-kiosk';
import { Roles } from '../auth/roles';
import { DashboardService } from './dashboard.service';

@Controller('v1/dashboard')
@Roles('operator', 'admin', 'viewer', 'kiosk')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @AllowKiosk()
  async getDashboard(
    @CurrentUser() user: AuthUser,
    @Query('host_id') hostId?: string,
    @Query('agent_id') agentId?: string,
    @Query('range') range?: string,
    @Query('tenant_id') tenantId?: string,
    @Query('view') view?: string,
  ) {
    const result = await this.dashboard.getDashboard(
      hostId || agentId,
      range,
      actingTenant(user, tenantId),
      user.role === 'kiosk' ? user.dashboard : view,
      user.role === 'kiosk' ? user.site : undefined,
    );
    return user.role === 'kiosk'
      ? this.restrictToDashboard(result, user.dashboard ?? 'hosts')
      : result;
  }

  private restrictToDashboard(payload: object, dashboard: string) {
    const source = payload as Record<string, unknown>;
    const custom = dashboard.startsWith('custom:');
    const inventories = {
      hosts: dashboard === 'hosts' || custom ? source['hosts'] : [],
      nics: dashboard === 'network' || custom ? source['nics'] : [],
      networkDevices: dashboard === 'network' ? source['networkDevices'] : [],
      databases: dashboard === 'databases' ? source['databases'] : [],
      queues: dashboard === 'queues' ? source['queues'] : [],
      icewarp: dashboard === 'icewarp' ? source['icewarp'] : [],
      icewarpBoard:
        dashboard === 'icewarp' ? source['icewarpBoard'] : undefined,
      sap: dashboard === 'sap' ? source['sap'] : [],
    };
    if (dashboard === 'hosts' || custom) {
      return { ...source, ...inventories };
    }
    return {
      ...source,
      ...inventories,
      agents: [],
      agentId: null,
      host: { id: null, series: {} },
      agent: {},
      logs: { volume: [], volumeAll: [], lines: [] },
    };
  }
}
