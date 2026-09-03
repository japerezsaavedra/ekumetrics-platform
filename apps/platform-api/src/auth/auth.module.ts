import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { KeycloakAdminService } from './keycloak-admin';
import { KioskModule } from '../kiosk/kiosk.module';
import { AuditInterceptor } from './audit.interceptor';
import { AuthController } from './auth.controller';
import { IdentityController } from './identity.controller';
import { TenantIdentityService } from './tenant-identity.service';

@Module({
  imports: [KioskModule],
  controllers: [AuthController, IdentityController],
  providers: [
    AuthService,
    KeycloakAdminService,
    TenantIdentityService,
    AuthGuard,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
  ],
  exports: [AuthService, KeycloakAdminService, TenantIdentityService],
})
export class AuthModule {}
