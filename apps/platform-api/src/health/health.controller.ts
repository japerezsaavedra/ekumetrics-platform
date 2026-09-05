import {
  Controller,
  Get,
  Inject,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Public } from '../auth/public';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import type { EventBus } from '../messaging/event-bus';
import { EVENT_BUS } from '../messaging/tokens';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() @Inject(EVENT_BUS) private readonly eventBus?: EventBus,
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
      const eventBusOk = this.eventBus ? await this.eventBus.ping() : false;
      return {
        status: 'ready',
        service: 'platform-api',
        version: this.config.get<string>('PRODUCT_VERSION') ?? 'development',
        checks: {
          database: 'ok',
          eventBus: eventBusOk ? 'ok' : 'degraded',
        },
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
