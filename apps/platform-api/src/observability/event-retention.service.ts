import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from './metrics.service';

@Injectable()
export class EventRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventRetentionService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit() {
    const days = this.integer('EVENT_RETENTION_DAYS', 0, 0, 3650);
    if (days === 0) {
      this.logger.warn(
        'Retención de AgentEvent deshabilitada; defina EVENT_RETENTION_DAYS.',
      );
      return;
    }
    const intervalMs = this.integer(
      'EVENT_RETENTION_INTERVAL_MS',
      3_600_000,
      60_000,
      86_400_000,
    );
    void this.purge(days);
    this.timer = setInterval(() => void this.purge(days), intervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async purge(days: number) {
    if (this.running) return 0;
    this.running = true;
    const batchSize = this.integer(
      'EVENT_RETENTION_BATCH_SIZE',
      1_000,
      100,
      10_000,
    );
    const maxBatches = this.integer(
      'EVENT_RETENTION_MAX_BATCHES',
      20,
      1,
      1_000,
    );
    const cutoff = new Date(Date.now() - days * 86_400_000);
    let deleted = 0;
    try {
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const events = await this.prisma.agentEvent.findMany({
          where: { receivedAt: { lt: cutoff } },
          select: { id: true },
          orderBy: { receivedAt: 'asc' },
          take: batchSize,
        });
        if (events.length === 0) break;
        const result = await this.prisma.agentEvent.deleteMany({
          where: { id: { in: events.map((event) => event.id) } },
        });
        deleted += result.count;
        if (events.length < batchSize) break;
      }
      this.metrics.recordRetentionSuccess(deleted);
      if (deleted > 0)
        this.logger.log(
          `Retención eliminó ${deleted} eventos anteriores a ${cutoff.toISOString()}.`,
        );
      return deleted;
    } catch (error) {
      this.metrics.recordRetentionFailure();
      this.logger.error(
        `Falló la retención de eventos: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }

  private integer(
    key: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ) {
    const value = Number(this.config.get<string>(key) ?? fallback);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(
        `${key} debe ser un entero entre ${minimum} y ${maximum}.`,
      );
    }
    return value;
  }
}
