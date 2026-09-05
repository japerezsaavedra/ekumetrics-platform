import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Optional,
  Param,
  Post,
  Query,
  Headers,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user';
import { Roles } from '../auth/roles';
import { actingTenant, type AuthUser } from '../auth/auth.types';
import { CorrelationService } from './correlation.service';
import { IncidentEnrichmentPublisher } from './enrichment/incident-enrichment.publisher';
import { IncidentEnrichmentService } from './enrichment/incident-enrichment.service';
import { parseRcaFeedbackAction } from './contracts/rca-feedback';
import { HistoricalService } from './historical/historical.service';
import type { RcaFeedbackInput } from './enrichment/incident-enrichment.types';

@Controller('v1')
@Roles('operator', 'admin')
export class IncidentsController {
  constructor(
    private readonly correlation: CorrelationService,
    private readonly enrichment: IncidentEnrichmentService,
    private readonly enrichmentPublisher: IncidentEnrichmentPublisher,
    @Optional() private readonly historical?: HistoricalService,
  ) {}

  @Get('incidents')
  async list(
    @CurrentUser() user: AuthUser,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const rows = await this.correlation.list(
      actingTenant(user, asSlug || headerSlug),
    );
    if (rows.length === 0) return rows;
    return this.enrichment.attachMany(rows[0].tenantId, rows);
  }

  @Get('incidents/:id')
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const incident = await this.correlation.get(
      actingTenant(user, asSlug || headerSlug),
      id,
    );
    const extra = await this.enrichment.find(incident.tenantId, incident.id);
    return { ...incident, enrichment: extra };
  }

  @Get('incidents/:id/enrichment')
  async enrichmentDetail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const incident = await this.correlation.get(
      actingTenant(user, asSlug || headerSlug),
      id,
    );
    const enrichment = await this.enrichment.find(
      incident.tenantId,
      incident.id,
    );
    return { incidentId: incident.id, enrichment };
  }

  @Post('incidents/correlate')
  async correlate(
    @CurrentUser() user: AuthUser,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const result = await this.correlation.correlate(
      actingTenant(user, asSlug || headerSlug),
      user.role === 'operator',
    );
    await this.enrichmentPublisher.requestMany(result.incidents);
    return result;
  }

  @Post('incidents/:id/enrich')
  async requestEnrichment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const incident = await this.correlation.get(
      actingTenant(user, asSlug || headerSlug),
      id,
    );
    await this.enrichmentPublisher.request({
      id: incident.id,
      tenantId: incident.tenantId,
    });
    return { accepted: true, incidentId: incident.id };
  }

  @Post('incidents/:id/rca-feedback')
  async rcaFeedback(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: RcaFeedbackInput,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const action = parseRcaFeedbackAction(body?.action);
    if (!action) {
      throw new BadRequestException(
        'Accion invalida. Use CONFIRM, REJECT, SELECT_ALTERNATIVE o ADD_NOTE.',
      );
    }
    const incident = await this.correlation.get(
      actingTenant(user, asSlug || headerSlug),
      id,
    );
    if (this.historical) {
      await this.historical.recordFeedback({
        tenantId: incident.tenantId,
        incidentId: incident.id,
        action,
        selectedEntityId: body.candidateId,
        note: body.note,
        userId: user.email,
      });
    }
    try {
      return await this.enrichment.applyRcaFeedback(incident.tenantId, incident.id, {
        action,
        candidateId: body.candidateId,
        note: body.note,
        actor: user.email,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'feedback RCA fallido';
      if (message.includes('Sin enriquecimiento')) {
        return {
          incidentId: incident.id,
          enrichment: null,
          action,
        };
      }
      throw new BadRequestException(message);
    }
  }

  @Get('graph')
  snapshot(
    @CurrentUser() user: AuthUser,
    @Query('site') site?: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.correlation.snapshot(
      actingTenant(user, asSlug || headerSlug),
      site,
    );
  }

  @Post('graph/example')
  seedExample(
    @CurrentUser() user: AuthUser,
    @Query('site') site?: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.correlation.seedExample(
      actingTenant(user, asSlug || headerSlug),
      site,
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
