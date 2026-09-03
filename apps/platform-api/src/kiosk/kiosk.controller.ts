import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AllowKiosk } from '../auth/allow-kiosk';
import { CurrentUser } from '../auth/current-user';
import { Public } from '../auth/public';
import type { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles';
import { KioskService } from './kiosk.service';

@Controller('v1/kiosk')
export class KioskController {
  constructor(private readonly kiosk: KioskService) {}

  @Public()
  @Post('session')
  renew(@Body() body: { deviceId?: string; deviceSecret?: string }) {
    return this.kiosk.renew(body.deviceId, body.deviceSecret);
  }

  @AllowKiosk()
  @Roles('kiosk')
  @Post('heartbeat')
  heartbeat(@CurrentUser() user: AuthUser) {
    return this.kiosk.heartbeat(user);
  }

  @Get('devices')
  @Roles('operator', 'admin')
  list(@CurrentUser() user: AuthUser, @Query('tenant') tenant?: string) {
    return this.kiosk.listDevices(user, tenant);
  }

  @Post('devices')
  @Roles('operator', 'admin')
  create(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      tenant?: string;
      site?: string;
      name?: string;
      dashboard?: string;
      credentialDays?: number;
    },
  ) {
    return this.kiosk.createDevice(user, body);
  }

  @Patch('devices/:id')
  @Roles('operator', 'admin')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { site?: string; dashboard?: string; name?: string },
  ) {
    return this.kiosk.updateScope(user, id, body);
  }

  @Post('devices/:id/rotate')
  @Roles('operator', 'admin')
  rotate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.kiosk.rotate(user, id);
  }

  @Post('devices/:id/revoke')
  @Roles('operator', 'admin')
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.kiosk.revoke(user, id);
  }

  @Delete('devices/:id')
  @Roles('operator', 'admin')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.kiosk.remove(user, id);
  }
}
