import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Headers,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/current-user';
import { Roles } from '../../auth/roles';
import { actingTenant, type AuthUser } from '../../auth/auth.types';
import { CorrelationService } from '../correlation.service';
import { IncidentEnrichmentService } from '../enrichment/incident-enrichment.service';
import {
  AGENT_ORCHESTRATOR,
  type AgentOrchestrator,
} from '../interfaces/agent-orchestrator';
import { AgentFindingRepository } from '../persistence/agent-finding.repository';
import { InvestigationRepository } from '../persistence/investigation.repository';
import { toProductInvestigationStatus } from '../types/aiops-investigation';
import { InvestigationContextBuilder } from './investigation-context.builder';

type InvestigateBody = {
  retry?: boolean;
};

@Controller('v1')
@Roles('operator', 'admin')
export class InvestigationController {
  constructor(
    private readonly correlation: CorrelationService,
    private readonly enrichment: IncidentEnrichmentService,
    private readonly investigations: InvestigationRepository,
    private readonly findings: AgentFindingRepository,
    private readonly contextBuilder: InvestigationContextBuilder,
    @Inject(AGENT_ORCHESTRATOR) private readonly orchestrator: AgentOrchestrator,
  ) {}

  @Post('incidents/:id/investigate')
  async investigate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: InvestigateBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const slug = actingTenant(user, asSlug || headerSlug);
    const incident = await this.correlation.get(slug, id);
    const enrichment = await this.enrichment.find(incident.tenantId, incident.id);
    const context = this.contextBuilder.build(incident, enrichment, slug);
    try {
      const investigation = await this.orchestrator.trigger({
        tenantId: incident.tenantId,
        incidentId: incident.id,
        context,
        trigger: body?.retry ? 'reopen' : 'operator',
        retry: Boolean(body?.retry),
        createdBy: user.email,
        tenantSlug: slug,
        correlationId: incident.id,
      });
      return this.toDto(investigation);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw error;
    }
  }

  @Post('incidents/:id/investigation/retry')
  async retry(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.investigate(user, id, { retry: true }, asSlug, headerSlug);
  }

  @Post('incidents/:id/investigation/cancel')
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const incident = await this.correlation.get(
      actingTenant(user, asSlug || headerSlug),
      id,
    );
    const row = await this.orchestrator.cancel(incident.tenantId, incident.id);
    return row ? this.toDto(row) : { cancelled: false };
  }

  @Get('incidents/:id/investigation')
  async latest(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('as') asSlug?: string,
    @Query('version') version?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const incident = await this.correlation.get(
      actingTenant(user, asSlug || headerSlug),
      id,
    );
    const rows = await this.investigations.listByIncident(
      incident.tenantId,
      incident.id,
    );
    const match = version
      ? rows.find((item) => String(item.version) === version)
      : rows[0];
    if (!match) {
      return { investigation: null };
    }
    return { investigation: this.toDto(match) };
  }

  @Get('incidents/:id/investigation/findings')
  async findingsForIncident(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const incident = await this.correlation.get(
      actingTenant(user, asSlug || headerSlug),
      id,
    );
    const latest = await this.investigations.findLatestByIncident(
      incident.tenantId,
      incident.id,
    );
    if (!latest) return { findings: [] };
    const findings = await this.findings.listByInvestigation(
      incident.tenantId,
      latest.id,
    );
    return { findings };
  }

  private toDto(row: Awaited<ReturnType<InvestigationRepository['create']>>) {
    return {
      ...row,
      productStatus: toProductInvestigationStatus(row.status),
    };
  }
}
