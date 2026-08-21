import { Body, Controller, Get, Headers, Post, Query } from '@nestjs/common';
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
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.listUsers(asSlug || headerSlug);
  }

  @Post('users')
  addUser(
    @Body() body: UserBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.addUser(
      asSlug || headerSlug,
      body.tenantSlug,
      body.email,
      body.displayName,
      body.role,
    );
  }
}
