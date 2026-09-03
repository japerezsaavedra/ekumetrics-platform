import { SetMetadata } from '@nestjs/common';
import type { AuthRole } from './auth.types';

export const AUTH_ROLES = 'authRoles';
export const Roles = (...roles: AuthRole[]) => SetMetadata(AUTH_ROLES, roles);
