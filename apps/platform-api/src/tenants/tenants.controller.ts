import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { actingTenant } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user';
import type { AuthUser } from '../auth/auth.types';
import { TenantsService } from './tenants.service';
import { Roles } from '../auth/roles';
import { AuditAction } from '../auth/audit-action';

type TenantBody = {
  name?: string;
  slug?: string;
  emailDomain?: string;
  adminEmail?: string;
  adminName?: string;
  siteName?: string;
  siteSlug?: string;
  modules?: string[];
};

type SiteBody = {
  name?: string;
  slug?: string;
};

type AgentBody = {
  agentId?: string;
  siteId?: string;
  mode?: string;
};

@Controller('v1/tenants')
@Roles('operator', 'admin', 'viewer')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const actor = actingTenant(user, asSlug || headerSlug);
    return this.tenants.list(actor, user.role === 'operator');
  }

  @Post()
  @Roles('operator')
  @AuditAction('tenant.created', 'tenant')
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: TenantBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.create(
      actingTenant(user, asSlug || headerSlug),
      body.name,
      body.slug,
      body.adminEmail,
      body.adminName,
      body.emailDomain,
      body.siteName,
      body.siteSlug,
      body.modules,
    );
  }

  @Patch(':slug')
  @Roles('operator')
  @AuditAction('tenant.updated', 'tenant')
  update(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Body() body: TenantBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.updateTenant(
      actingTenant(user, asSlug || headerSlug),
      slug,
      body.name,
      body.emailDomain,
      body.modules,
    );
  }

  @Delete(':slug')
  @Roles('operator')
  @AuditAction('tenant.deleted', 'tenant')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.removeTenant(
      actingTenant(user, asSlug || headerSlug),
      slug,
    );
  }

  @Get(':slug/sites')
  listSites(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.listSites(
      actingTenant(user, asSlug || headerSlug),
      slug,
    );
  }

  @Post(':slug/sites')
  @Roles('operator', 'admin')
  @AuditAction('tenant.site.created', 'site')
  addSite(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Body() body: SiteBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.addSite(
      actingTenant(user, asSlug || headerSlug),
      slug,
      body.name,
      body.slug,
    );
  }

  @Patch(':slug/sites/:siteId')
  @Roles('operator', 'admin')
  @AuditAction('tenant.site.updated', 'site')
  updateSite(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Param('siteId') siteId: string,
    @Body() body: SiteBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.updateSite(
      actingTenant(user, asSlug || headerSlug),
      slug,
      siteId,
      body.name,
      body.slug,
    );
  }

  @Delete(':slug/sites/:siteId')
  @Roles('operator', 'admin')
  @AuditAction('tenant.site.deleted', 'site')
  removeSite(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Param('siteId') siteId: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.removeSite(
      actingTenant(user, asSlug || headerSlug),
      slug,
      siteId,
    );
  }

  @Get(':slug/agents')
  listAgents(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.listAgents(
      actingTenant(user, asSlug || headerSlug),
      slug,
    );
  }

  @Post(':slug/agents')
  @Roles('operator', 'admin')
  @AuditAction('tenant.agent.created', 'agent')
  addAgent(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Body() body: AgentBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.addAgent(
      actingTenant(user, asSlug || headerSlug),
      slug,
      body.agentId,
      body.siteId,
      body.mode,
    );
  }

  @Patch(':slug/agents/:id')
  @Roles('operator', 'admin')
  @AuditAction('tenant.agent.updated', 'agent')
  updateAgent(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Body() body: AgentBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.updateAgent(
      actingTenant(user, asSlug || headerSlug),
      slug,
      id,
      body.siteId,
      body.mode,
    );
  }

  @Delete(':slug/agents/:id')
  @Roles('operator', 'admin')
  @AuditAction('tenant.agent.deleted', 'agent')
  removeAgent(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.removeAgent(
      actingTenant(user, asSlug || headerSlug),
      slug,
      id,
    );
  }
}
