import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../observability/metrics.service';
import { assertTenantScope } from '../aiops/persistence/tenant-scope.error';
import type { EventBus, EventHeaders, OutboundMessage } from './event-bus';
import { EVENT_BUS } from './tokens';
import { EventOutboxMetrics } from './event-outbox.metrics';
import {
  EVENT_OUTBOX,
  OUTBOX_STATUS,
  type OutboxEnqueueInput,
} from './event-outbox.types';
import { EventBusUnavailableError } from './errors';

const FLUSH_INTERVAL_MS = 2_000;
const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 8;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000];

type OutboxClient = {
  aiopsEventOutbox: {
    createMany(args: {
      data: Prisma.AiopsEventOutboxCreateManyInput[];
      skipDuplicates?: boolean;
    }): Promise<{ count: number }>;
  };
};

/**
 * Outbox durable para publish EventBus. El HTTP de ingest no espera a anomalía.
 * Varias réplicas de platform-api reclaman filas con updateMany condicional.
 */
@Injectable()
export class EventOutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventOutboxService.name);
  private timer?: ReturnType<typeof setInterval>;
  private flushing = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    private readonly metrics: EventOutboxMetrics,
    @Optional() platformMetrics?: MetricsService,
  ) {
    platformMetrics?.registerContributor('aiops-event-outbox', () =>
      this.metrics.render(),
    );
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref?.();
    void this.flush();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  async enqueueMany(
    client: OutboxClient,
    rows: OutboxEnqueueInput[],
  ): Promise<void> {
    if (rows.length === 0) return;
    for (const row of rows) {
      assertTenantScope(row.tenantId);
      if (row.headers.tenantId !== row.tenantId) {
        throw new Error('tenantId header/payload mismatch');
      }
    }
    await client.aiopsEventOutbox.createMany({
      skipDuplicates: true,
      data: rows.map((row) => ({
        tenantId: row.tenantId,
        subject: row.subject,
        idempotencyKey: row.idempotencyKey,
        payload: row.payload as Prisma.InputJsonValue,
        headers: row.headers as unknown as Prisma.InputJsonValue,
        status: OUTBOX_STATUS.PENDING,
        availableAt: new Date(),
      })),
    });
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const pending = await this.prisma.aiopsEventOutbox.findMany({
        where: {
          status: OUTBOX_STATUS.PENDING,
          availableAt: { lte: new Date() },
        },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });
      for (const row of pending) {
        await this.publishOne(row);
      }
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'aiops.outbox.flush.failed',
          error: error instanceof Error ? error.message : 'unknown',
        }),
      );
    } finally {
      this.flushing = false;
    }
  }

  private async publishOne(row: {
    id: string;
    tenantId: string;
    subject: string;
    idempotencyKey: string;
    payload: unknown;
    headers: unknown;
    attempts: number;
  }): Promise<void> {
    const claimed = await this.prisma.aiopsEventOutbox.updateMany({
      where: {
        id: row.id,
        tenantId: row.tenantId,
        status: OUTBOX_STATUS.PENDING,
      },
      data: {
        status: OUTBOX_STATUS.PUBLISHING,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return;

    const headers = row.headers as EventHeaders;
    const message: OutboundMessage<unknown> = {
      payload: row.payload,
      headers,
      idempotencyKey: row.idempotencyKey,
    };
    try {
      await this.eventBus.publish(row.subject, message);
      await this.prisma.aiopsEventOutbox.updateMany({
        where: { id: row.id, tenantId: row.tenantId },
        data: {
          status: OUTBOX_STATUS.PUBLISHED,
          publishedAt: new Date(),
          lastError: null,
        },
      });
      this.metrics.recordPublished(row.subject);
    } catch (error) {
      this.metrics.recordFailure(row.subject);
      const attempts = row.attempts + 1;
      const messageText = error instanceof Error ? error.message : 'unknown';
      const exhausted = attempts >= MAX_ATTEMPTS;
      const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
      await this.prisma.aiopsEventOutbox.updateMany({
        where: { id: row.id, tenantId: row.tenantId },
        data: {
          status: exhausted ? OUTBOX_STATUS.FAILED : OUTBOX_STATUS.PENDING,
          lastError: messageText.slice(0, 500),
          availableAt: new Date(Date.now() + delay),
        },
      });
      const event =
        error instanceof EventBusUnavailableError
          ? 'aiops.outbox.publish.skipped'
          : 'aiops.outbox.publish.failed';
      this.logger.warn(
        JSON.stringify({
          event,
          tenantId: row.tenantId,
          subject: row.subject,
          idempotencyKey: row.idempotencyKey,
          attempts,
          error: messageText,
        }),
      );
    }
  }
}

export { EVENT_OUTBOX };
