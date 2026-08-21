import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { TenantsService } from './tenants.service';

type TenantBody = {
  name?: string;
  slug?: string;
  emailDomain?: string;
  adminEmail?: string;
  adminName?: string;
  siteName?: string;
  siteSlug?: string;
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
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  list(
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.list(asSlug || headerSlug);
  }

  @Post()
  create(
    @Body() body: TenantBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.create(
      asSlug || headerSlug,
      body.name,
      body.slug,
      body.adminEmail,
      body.adminName,
      body.emailDomain,
      body.siteName,
      body.siteSlug,
    );
  }

  @Get(':slug/sites')
  listSites(
    @Param('slug') slug: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.listSites(asSlug || headerSlug, slug);
  }

  @Post(':slug/sites')
  addSite(
    @Param('slug') slug: string,
    @Body() body: SiteBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.addSite(asSlug || headerSlug, slug, body.name, body.slug);
  }

  @Get(':slug/agents')
  listAgents(@Param('slug') slug: string) {
    return this.tenants.listAgents(slug);
  }

  @Post(':slug/agents')
  addAgent(
    @Param('slug') slug: string,
    @Body() body: AgentBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.tenants.addAgent(asSlug || headerSlug, slug, body.agentId, body.siteId, body.mode);
  }
}
