import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { actingTenant } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user';
import type { AuthUser } from '../auth/auth.types';
import { TenantsService } from './tenants.service';

type UserBody = {
  tenantSlug?: string;
  email?: string;
  displayName?: string;
  role?: string;
};

@Controller('v1/admin')
export class AdminController {
  constructor(private readonly tenants: TenantsService) {}

  @Get('users')
  listUsers(
    @CurrentUser() user: AuthUser,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.listUsers(actingTenant(user, asSlug || headerSlug));
  }

  @Post('users')
  addUser(
    @CurrentUser() user: AuthUser,
    @Body() body: UserBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.addUser(
      actingTenant(user, asSlug || headerSlug),
      body.tenantSlug,
      body.email,
      body.displayName,
      body.role,
    );
  }

  @Patch('users/:id')
  updateUser(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: UserBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.updateUser(actingTenant(user, asSlug || headerSlug), id, body.displayName, body.role);
  }

  @Delete('users/:id')
  removeUser(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.removeUser(actingTenant(user, asSlug || headerSlug), user.email, id);
  }
}
