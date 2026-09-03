import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AiRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiRetentionService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    const intervalMs = this.integer(
      'AI_INQUIRY_RETENTION_INTERVAL_MS',
      3_600_000,
      60_000,
      86_400_000,
    );
    void this.purge();
    this.timer = setInterval(() => void this.purge(), intervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async purge(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const batchSize = this.integer(
      'AI_INQUIRY_RETENTION_BATCH_SIZE',
      500,
      10,
      5_000,
    );
    try {
      const now = new Date();
      const conversations = await this.prisma.aiConversation.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true },
        orderBy: { expiresAt: 'asc' },
        take: batchSize,
      });
      const deletedConversations = conversations.length
        ? await this.prisma.aiConversation.deleteMany({
            where: { id: { in: conversations.map((item) => item.id) } },
          })
        : { count: 0 };
      const legacy = await this.prisma.aiInquiry.findMany({
        where: { conversationId: null, retentionUntil: { lt: now } },
        select: { id: true },
        orderBy: { retentionUntil: 'asc' },
        take: batchSize,
      });
      const deletedLegacy = legacy.length
        ? await this.prisma.aiInquiry.deleteMany({
            where: { id: { in: legacy.map((item) => item.id) } },
          })
        : { count: 0 };
      const deleted = deletedConversations.count + deletedLegacy.count;
      if (deleted > 0) {
        this.logger.log(
          `Retencion elimino ${deletedConversations.count} conversaciones y ${deletedLegacy.count} investigaciones heredadas.`,
        );
      }
      return deleted;
    } catch (error) {
      this.logger.error(
        `Fallo la retencion de investigaciones: ${error instanceof Error ? error.message : String(error)}`,
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
  ): number {
    const value = Number(this.config.get<string>(key) ?? fallback);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(
        `${key} debe ser un entero entre ${minimum} y ${maximum}.`,
      );
    }
    return value;
  }
}
