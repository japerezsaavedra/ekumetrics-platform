import { Body, Controller, Get, Headers, Put, Query } from '@nestjs/common';
import { AuditAction } from './audit-action';
import { actingTenant, type AuthUser } from './auth.types';
import { CurrentUser } from './current-user';
import { Roles } from './roles';
import {
  TenantIdentityService,
  type IdentityBody,
} from './tenant-identity.service';

@Controller('v1/identity')
@Roles('operator', 'admin')
export class IdentityController {
  constructor(private readonly identity: TenantIdentityService) {}

  @Get()
  get(
    @CurrentUser() user: AuthUser,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.identity.get(actingTenant(user, asSlug || headerSlug));
  }

  @Put()
  @AuditAction('tenant.identity.updated', 'tenant_identity')
  save(
    @CurrentUser() user: AuthUser,
    @Body() body: IdentityBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.identity.save(actingTenant(user, asSlug || headerSlug), body);
  }
}
