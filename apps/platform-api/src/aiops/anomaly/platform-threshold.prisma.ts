import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DEFAULT_PLATFORM_THRESHOLDS,
  mergePlatformThresholds,
  type PlatformThresholds,
} from '../../platform/platform-thresholds';
import type { PlatformThresholdSource } from './platform-threshold.source';

/**
 * Lee `PlatformThresholds` existente (no duplica la tabla).
 * Slot `agents:<tenantId>` o fila con tenantId.
 */
@Injectable()
export class PrismaPlatformThresholdSource implements PlatformThresholdSource {
  constructor(private readonly prisma: PrismaService) {}

  async getForTenant(tenantId: string): Promise<PlatformThresholds> {
    if (!tenantId) {
      return { ...DEFAULT_PLATFORM_THRESHOLDS };
    }
    try {
      const row = await this.prisma.platformThresholds.findFirst({
        where: {
          OR: [{ tenantId }, { slot: `agents:${tenantId}` }],
        },
      });
      return mergePlatformThresholds(row?.values);
    } catch {
      return { ...DEFAULT_PLATFORM_THRESHOLDS };
    }
  }
}
