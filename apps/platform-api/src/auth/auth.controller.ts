import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from './public';

type LoginBody = {
  email?: string;
  password?: string;
};

type ChangePasswordBody = {
  email?: string;
  currentPassword?: string;
  newPassword?: string;
  confirmPassword?: string;
};

@Public()
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() body: LoginBody) {
    return this.auth.passwordLogin(body.email, body.password);
  }

  @Post('first-password')
  firstPassword(@Body() body: ChangePasswordBody) {
    return this.auth.changeFirstPassword(
      body.email,
      body.currentPassword,
      body.newPassword,
      body.confirmPassword,
    );
  }
}
