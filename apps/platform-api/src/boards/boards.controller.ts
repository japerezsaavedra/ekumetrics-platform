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
import type { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles';
import { BoardsService } from './boards.service';

@Controller('v1/boards')
export class BoardsController {
  constructor(private readonly boards: BoardsService) {}

  @Get()
  @Roles('operator', 'admin', 'viewer')
  list(@CurrentUser() user: AuthUser, @Query('tenant') tenant?: string) {
    return this.boards.list(user, tenant);
  }

  @Post()
  @Roles('operator', 'admin')
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: { name?: string; siteId?: string | null; tenant?: string },
  ) {
    return this.boards.create(user, body);
  }

  @Get(':id/view')
  @AllowKiosk()
  @Roles('operator', 'admin', 'viewer', 'kiosk')
  view(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('tenant') tenant?: string,
  ) {
    return this.boards.view(user, id, tenant);
  }

  @Get(':id')
  @Roles('operator', 'admin', 'viewer')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('tenant') tenant?: string,
  ) {
    return this.boards.get(user, id, tenant);
  }

  @Patch(':id')
  @Roles('operator', 'admin')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { name?: string; widgets?: unknown; siteId?: string | null; tenant?: string },
  ) {
    return this.boards.update(user, id, body, body.tenant);
  }

  @Delete(':id')
  @Roles('operator', 'admin')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('tenant') tenant?: string,
  ) {
    return this.boards.remove(user, id, tenant);
  }
}
