import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  EVENT_BUS,
  EventBusUnavailableError,
  EventSubjects,
  buildHeaders,
  type EventBus,
} from '../../messaging';
import { PrismaService } from '../../prisma/prisma.service';
import { EventOutboxService } from '../../messaging/event-outbox.service';
import type { EnrichmentRequestedPayload } from './incident-enrichment.types';
import type { RcaRequestedPayload } from '../rca/types';

type IncidentRef = { id: string; tenantId: string };

@Injectable()
export class IncidentEnrichmentPublisher {
  private readonly logger = new Logger(IncidentEnrichmentPublisher.name);

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly outbox?: EventOutboxService,
  ) {}

  async requestMany(incidents: IncidentRef[]): Promise<void> {
    for (const incident of incidents) {
      await this.request(incident);
    }
  }

  async request(incident: IncidentRef): Promise<void> {
    if (!incident.tenantId || !incident.id) return;
    const payload: EnrichmentRequestedPayload = {
      tenantId: incident.tenantId,
      incidentId: incident.id,
    };
    try {
      await this.eventBus.publish(EventSubjects.INCIDENTS_ENRICHMENT_REQUESTED, {
        payload,
        headers: buildHeaders({
          tenantId: incident.tenantId,
          incidentId: incident.id,
          correlationId: `enrichment:${incident.id}`,
          producedBy: 'aiops.incident-enrichment',
        }),
        idempotencyKey: `${incident.tenantId}:incidents.enrichment.requested:${incident.id}`,
      });
    } catch (error) {
      if (error instanceof EventBusUnavailableError) {
        this.logger.warn(
          `aiops incident enrichment request skipped bus_unavailable tenantId=${incident.tenantId} incidentId=${incident.id}`,
        );
        return;
      }
      this.logger.error(
        `aiops incident enrichment request failed tenantId=${incident.tenantId} incidentId=${incident.id} error=${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  async requestRca(incident: IncidentRef): Promise<void> {
    if (!incident.tenantId || !incident.id) return;
    const payload: RcaRequestedPayload = {
      tenantId: incident.tenantId,
      incidentId: incident.id,
    };
    const headers = buildHeaders({
      tenantId: incident.tenantId,
      incidentId: incident.id,
      correlationId: `rca:${incident.id}`,
      producedBy: 'aiops.incident-enrichment',
    });
    const idempotencyKey = `${incident.tenantId}:rca.requested:${incident.id}`;
    if (this.outbox && this.prisma) {
      try {
        await this.outbox.enqueueMany(this.prisma, [
          {
            tenantId: incident.tenantId,
            subject: EventSubjects.RCA_REQUESTED,
            idempotencyKey,
            payload,
            headers,
          },
        ]);
        void this.outbox.flush();
        return;
      } catch (error) {
        this.logger.warn(
          `aiops rca.requested outbox failed tenantId=${incident.tenantId} incidentId=${incident.id} error=${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }
    try {
      await this.eventBus.publish(EventSubjects.RCA_REQUESTED, {
        payload,
        headers,
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof EventBusUnavailableError) {
        this.logger.warn(
          `aiops rca.requested skipped bus_unavailable tenantId=${incident.tenantId} incidentId=${incident.id}`,
        );
        return;
      }
      this.logger.error(
        `aiops rca.requested failed tenantId=${incident.tenantId} incidentId=${incident.id} error=${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }
}
