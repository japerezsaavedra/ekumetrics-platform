import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/public';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  liveness() {
    return {
      status: 'ok',
      service: 'platform-api',
      version: this.config.get<string>('PRODUCT_VERSION') ?? 'development',
    };
  }

  @Get('ready')
  async readiness() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'ready',
        service: 'platform-api',
        version: this.config.get<string>('PRODUCT_VERSION') ?? 'development',
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'database unavailable';
      throw new ServiceUnavailableException({
        status: 'unavailable',
        service: 'platform-api',
        message,
      });
    }
  }
}
