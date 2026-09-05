import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { actingTenant, type AuthUser } from '../../auth/auth.types';
import { AuditAction } from '../../auth/audit-action';
import { CurrentUser } from '../../auth/current-user';
import { Roles } from '../../auth/roles';
import { PrismaService } from '../../prisma/prisma.service';
import { HistoricalService } from './historical.service';
import type { IncidentSignatureInput } from './types';
import { parseRcaFeedbackAction } from '../contracts/rca-feedback';

type FeedbackBody = {
  action?: string;
  selectedEntityId?: string;
  note?: string;
  confirmedRootCause?: string;
  rejectedRootCause?: string;
  resolution?: string;
  successfulAction?: string;
  timeToDetectMs?: number;
  timeToResolveMs?: number;
  signature?: IncidentSignatureInput;
};

type LookupBody = {
  entityTypes?: string[];
  service?: string;
  serviceKey?: string;
  eventTypes?: string[];
  anomalyTypes?: string[];
  topologyPattern?: string | string[];
  environment?: string;
  proposedRootCause?: string;
  entityIds?: string[];
  entityKeys?: string[];
  fingerprints?: string[];
};

@Controller('v1/incidents')
@Roles('operator', 'admin')
export class HistoricalController {
  constructor(
    private readonly historical: HistoricalService,
    private readonly prisma: PrismaService,
  ) {}

  @Post(':incidentId/rca-feedback')
  @AuditAction('aiops.rca.feedback', 'incident')
  async recordFeedback(
    @CurrentUser() user: AuthUser,
    @Param('incidentId') incidentId: string,
    @Body() body: FeedbackBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const tenant = await this.requireIncident(
      actingTenant(user, asSlug || headerSlug),
      incidentId,
    );
    const action = parseRcaFeedbackAction(body.action);
    if (!action) {
      throw new BadRequestException(
        'action debe ser CONFIRM, REJECT, SELECT_ALTERNATIVE o ADD_NOTE.',
      );
    }
    if (
      action === 'ADD_NOTE' &&
      !body.note?.trim() &&
      !body.resolution?.trim()
    ) {
      throw new BadRequestException('ADD_NOTE requiere note o resolution.');
    }
    if (
      action === 'SELECT_ALTERNATIVE' &&
      !body.selectedEntityId?.trim() &&
      !body.confirmedRootCause?.trim()
    ) {
      throw new BadRequestException(
        'SELECT_ALTERNATIVE requiere selectedEntityId o confirmedRootCause.',
      );
    }
    const signature = body.signature
      ? { ...body.signature, tenantId: tenant.id, incidentId }
      : undefined;
    return this.historical.recordFeedback({
      tenantId: tenant.id,
      incidentId,
      action,
      selectedEntityId: body.selectedEntityId,
      note: body.note,
      userId: user.email,
      signature,
      confirmedRootCause: body.confirmedRootCause,
      rejectedRootCause: body.rejectedRootCause,
      resolution: body.resolution,
      successfulAction: body.successfulAction,
      timeToDetectMs: body.timeToDetectMs,
      timeToResolveMs: body.timeToResolveMs,
    });
  }

  @Get(':incidentId/rca-feedback')
  async listFeedback(
    @CurrentUser() user: AuthUser,
    @Param('incidentId') incidentId: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const tenant = await this.requireIncident(
      actingTenant(user, asSlug || headerSlug),
      incidentId,
    );
    return this.historical.listFeedback(tenant.id, incidentId);
  }

  @Get(':incidentId/historical')
  async historicalForIncident(
    @CurrentUser() user: AuthUser,
    @Param('incidentId') incidentId: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const tenant = await this.requireIncident(
      actingTenant(user, asSlug || headerSlug),
      incidentId,
    );
    const [contribution, resolution, feedback] = await Promise.all([
      this.historical.lookupForIncident(tenant.id, incidentId),
      this.historical.findResolution(tenant.id, incidentId),
      this.historical.listFeedback(tenant.id, incidentId),
    ]);
    return { contribution, resolution, feedback };
  }

  @Post(':incidentId/historical/lookup')
  async lookup(
    @CurrentUser() user: AuthUser,
    @Param('incidentId') incidentId: string,
    @Body() body: LookupBody,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const tenant = await this.requireIncident(
      actingTenant(user, asSlug || headerSlug),
      incidentId,
    );
    await this.historical.recordSignature(
      tenant.id,
      {
        tenantId: tenant.id,
        incidentId,
        entityTypes: body.entityTypes,
        service: body.service,
        serviceKey: body.serviceKey,
        eventTypes: body.eventTypes,
        anomalyTypes: body.anomalyTypes,
        topologyPattern: body.topologyPattern,
        environment: body.environment,
        proposedRootCause: body.proposedRootCause,
        entityIds: body.entityIds,
        entityKeys: body.entityKeys,
        fingerprints: body.fingerprints,
      },
      incidentId,
    );
    return this.historical.lookup(tenant.id, {
      tenantId: tenant.id,
      incidentId,
      entityTypes: body.entityTypes,
      service: body.service,
      serviceKey: body.serviceKey,
      eventTypes: body.eventTypes,
      anomalyTypes: body.anomalyTypes,
      topologyPattern: body.topologyPattern,
      environment: body.environment,
      proposedRootCause: body.proposedRootCause,
      entityIds: body.entityIds,
      entityKeys: body.entityKeys,
      fingerprints: body.fingerprints,
    });
  }

  @Get(':incidentId/resolution')
  async resolution(
    @CurrentUser() user: AuthUser,
    @Param('incidentId') incidentId: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const tenant = await this.requireIncident(
      actingTenant(user, asSlug || headerSlug),
      incidentId,
    );
    const row = await this.historical.findResolution(tenant.id, incidentId);
    if (!row) {
      throw new NotFoundException(
        'No hay ResolutionRecord para este incidente.',
      );
    }
    return row;
  }

  private async requireIncident(tenantSlug: string, incidentId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: tenantSlug },
    });
    if (!tenant) {
      throw new NotFoundException('El tenant no existe.');
    }
    const incident = await this.prisma.incident.findFirst({
      where: { id: incidentId, tenantId: tenant.id },
    });
    if (!incident) {
      throw new NotFoundException('El incidente no existe.');
    }
    return tenant;
  }
}
