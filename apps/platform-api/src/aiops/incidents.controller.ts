import { Controller, Get, Param, Post, Query, Headers } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user';
import { Roles } from '../auth/roles';
import { actingTenant, type AuthUser } from '../auth/auth.types';
import { CorrelationService } from './correlation.service';

@Controller('v1')
@Roles('operator', 'admin')
export class IncidentsController {
  constructor(private readonly correlation: CorrelationService) {}

  @Get('incidents')
  list(
    @CurrentUser() user: AuthUser,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.correlation.list(actingTenant(user, asSlug || headerSlug));
  }

  @Get('incidents/:id')
  detail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.correlation.get(actingTenant(user, asSlug || headerSlug), id);
  }

  @Post('incidents/correlate')
  correlate(
    @CurrentUser() user: AuthUser,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.correlation.correlate(
      actingTenant(user, asSlug || headerSlug),
      user.role === 'operator',
    );
  }

  @Get('graph/impact')
  impact(
    @CurrentUser() user: AuthUser,
    @Query('node') node: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.correlation.impact(
      actingTenant(user, asSlug || headerSlug),
      node,
    );
  }
}
