import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { IS_PUBLIC } from './public';
import { ALLOW_KIOSK } from './allow-kiosk';
import type { AuthUser } from './auth.types';
import { AUTH_ROLES } from './roles';
import type { Request } from 'express';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const open = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (open) {
      return true;
    }
    const request = context.switchToHttp().getRequest<
      Request & {
        user?: AuthUser;
        csrfToken?: string;
      }
    >();
    const session = await this.auth.authenticate(request);
    const user = session.user;
    const roles = this.reflector.getAllAndOverride<AuthUser['role'][]>(
      AUTH_ROLES,
      [context.getHandler(), context.getClass()],
    );
    if (!roles?.length || !roles.includes(user.role)) {
      throw new ForbiddenException(
        'No tiene permisos para acceder a este recurso.',
      );
    }
    const kioskAllowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_KIOSK,
      [context.getHandler(), context.getClass()],
    );
    if (user.role === 'kiosk' && !kioskAllowed) {
      throw new ForbiddenException(
        'La identidad del dispositivo no puede acceder a este recurso.',
      );
    }
    request.user = user;
    request.csrfToken = session.csrfToken;
    return true;
  }
}
