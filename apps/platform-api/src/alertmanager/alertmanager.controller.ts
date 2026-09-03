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
import { AuditAction } from '../auth/audit-action';
import { CurrentUser } from '../auth/current-user';
import { Roles } from '../auth/roles';
import { actingTenant, type AuthUser } from '../auth/auth.types';
import { AlertChannelsService } from './alert-channels.service';
import {
  AlertmanagerService,
  type AlertmanagerMatcher,
} from './alertmanager.service';

@Controller('v1/alerts')
@Roles('operator', 'admin')
export class AlertmanagerController {
  constructor(
    private readonly alertmanager: AlertmanagerService,
    private readonly channels: AlertChannelsService,
  ) {}

  @Get()
  overview(
    @CurrentUser() user: AuthUser,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    const tenant = actingTenant(user, asSlug || headerSlug);
    return this.alertmanager.overview(tenant, user.role === 'operator');
  }

  @Get('channels')
  listChannels(
    @CurrentUser() user: AuthUser,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.channels.list(actingTenant(user, asSlug || headerSlug));
  }

  @Post('channels')
  @AuditAction('alerts.channel.created', 'alert_channel')
  createChannel(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.channels.create(actingTenant(user, asSlug || headerSlug), body);
  }

  @Patch('channels/:id')
  @AuditAction('alerts.channel.updated', 'alert_channel')
  updateChannel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.channels.update(
      actingTenant(user, asSlug || headerSlug),
      id,
      body,
    );
  }

  @Delete('channels/:id')
  @AuditAction('alerts.channel.deleted', 'alert_channel')
  removeChannel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.channels.remove(actingTenant(user, asSlug || headerSlug), id);
  }

  @Post('silences')
  @AuditAction('alerts.silence.created', 'alert_silence')
  createSilence(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      comment?: string;
      durationMinutes?: number;
      matchers?: AlertmanagerMatcher[];
    },
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.alertmanager.createSilence(
      user.email,
      actingTenant(user, asSlug || headerSlug),
      body,
    );
  }

  @Delete('silences/:id')
  @AuditAction('alerts.silence.expired', 'alert_silence')
  expireSilence(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('as') asSlug?: string,
    @Headers('x-eku-tenant') headerSlug?: string,
  ) {
    return this.alertmanager.expireSilence(
      id,
      actingTenant(user, asSlug || headerSlug),
      user.role === 'operator',
    );
  }
}
