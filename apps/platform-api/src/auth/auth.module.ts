import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { KeycloakAdminService } from './keycloak-admin';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    KeycloakAdminService,
    AuthGuard,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  exports: [AuthService, KeycloakAdminService],
})
export class AuthModule {}
