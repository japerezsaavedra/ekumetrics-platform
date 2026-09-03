import { Body, Controller, Get, Headers, Put, Query } from '@nestjs/common';
import { actingTenant } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user';
import type { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles';
import { PlatformService } from './platform.service';

@Controller('v1/platform')
@Roles('operator', 'admin')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('overview')
  overview() {
    return this.platform.overview();
  }

  @Get('logs')
  logs(@Query('from') from?: string, @Query('to') to?: string) {
    return this.platform.queryLogs(from, to);
  }

  @Get('thresholds')
  thresholds(
    @CurrentUser() user: AuthUser,
    @Query('scope') scope = 'agents',
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.platform.thresholds(scope, actingTenant(user, asSlug || headerSlug));
  }

  @Put('thresholds')
  saveThresholds(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @Query('scope') scope = 'agents',
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.platform.saveThresholds(
      scope,
      body,
      actingTenant(user, asSlug || headerSlug),
    );
  }
}
