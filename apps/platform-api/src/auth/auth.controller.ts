import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from './public';
import { Roles } from './roles';
import type { AuthUser } from './auth.types';

type AuthenticatedRequest = Request & { user: AuthUser; csrfToken: string };

type LoginBody = {
  email?: string;
  password?: string;
  totp?: string;
  redirect?: string;
};

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('login-options')
  @Public()
  loginOptions(@Query('email') email?: string) {
    return this.auth.loginOptions(email ?? '');
  }

  @Get('broker')
  @Public()
  async broker(
    @Res() response: Response,
    @Query('email') email?: string,
    @Query('redirect') redirect?: string,
  ): Promise<void> {
    const authorizationUrl = await this.auth.beginBroker(
      response,
      email ?? '',
      redirect,
    );
    response.redirect(302, authorizationUrl);
  }

  @Get('enroll')
  @Public()
  enroll(
    @Res() response: Response,
    @Query('redirect') redirect?: string,
  ): void {
    response.redirect(302, this.auth.beginLogin(response, redirect));
  }

  @Post('login')
  @Public()
  async login(
    @Req() request: Request,
    @Res() response: Response,
    @Body() body: LoginBody,
  ): Promise<void> {
    const session = await this.auth.loginWithPassword(request, response, body);
    response.status(200).json(session);
  }

  @Get('callback')
  @Public()
  async callback(
    @Req() request: Request,
    @Res() response: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
  ): Promise<void> {
    const redirect = await this.auth.completeLogin(
      request,
      response,
      code,
      state,
    );
    response.redirect(303, redirect);
  }

  @Get('session')
  @Roles('operator', 'admin', 'viewer')
  async session(@Req() request: AuthenticatedRequest) {
    return {
      user: request.user,
      csrfToken: request.csrfToken,
      mfaEnrollmentRequired: await this.auth.mfaEnrollmentRequired(
        request.user.email,
      ),
    };
  }

  @Post('mfa/setup')
  @Roles('operator', 'admin', 'viewer')
  beginMfa(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.auth.beginMfaSetup(request.user, response);
  }

  @Post('mfa/confirm')
  @Roles('operator', 'admin', 'viewer')
  confirmMfa(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Body() body: { totp?: string },
  ) {
    return this.auth.confirmMfaSetup(request, response, request.user, body.totp);
  }

  @Post('logout')
  @Roles('operator', 'admin', 'viewer')
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.auth.logout(request, response);
  }
}
