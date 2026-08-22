import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Public } from '../auth/public';
import { PrismaService } from '../prisma/prisma.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  liveness() {
    return { status: 'ok', service: 'platform-api' };
  }

  @Get('ready')
  async readiness() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', service: 'platform-api' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'database unavailable';
      throw new ServiceUnavailableException({
        status: 'unavailable',
        service: 'platform-api',
        message,
      });
    }
  }
}
