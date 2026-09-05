import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  EVENT_BUS,
  EventSubjects,
  type EventBus,
  type Subscription,
} from '../../messaging';
import type { IncidentEnrichedPayload } from '../contracts/events';
import {
  AGENT_ORCHESTRATOR,
  type AgentOrchestrator,
} from '../interfaces/agent-orchestrator';
import { IncidentEnrichmentService } from '../enrichment/incident-enrichment.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InvestigationContextBuilder } from './investigation-context.builder';
import { InvestigationPolicyService } from './investigation-policy.service';

const CONSUMER = 'aiops-investigation-policy';

@Injectable()
export class InvestigationRequestedSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InvestigationRequestedSubscriber.name);
  private subscription?: Subscription;

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    @Inject(AGENT_ORCHESTRATOR) private readonly orchestrator: AgentOrchestrator,
    private readonly policy: InvestigationPolicyService,
    private readonly enrichment: IncidentEnrichmentService,
    private readonly prisma: PrismaService,
    private readonly contextBuilder: InvestigationContextBuilder,
  ) {}

  async onModuleInit(): Promise<void> {
    this.subscription = await this.eventBus.subscribe<IncidentEnrichedPayload>(
      {
        subject: EventSubjects.INCIDENTS_ENRICHED,
        consumerName: CONSUMER,
        queueGroup: CONSUMER,
      },
      async (msg, ctrl) => {
        const tenantId = msg.headers.tenantId;
        const payload = msg.payload;
        if (!tenantId || !payload?.tenantId) {
          await ctrl.term('tenantId is required');
          return;
        }
        if (payload.tenantId !== tenantId) {
          await ctrl.term('tenantId header/payload mismatch');
          return;
        }
        const resolved = await this.policy.resolve(tenantId);
        if (!this.policy.shouldAutoInvestigate(resolved)) {
          this.logger.log(
            `aiops investigation skipped mode=MANUAL tenantId=${tenantId} incidentId=${payload.incidentId}`,
          );
          await ctrl.ack();
          return;
        }
        try {
          const incident = await this.prisma.incident.findFirst({
            where: { id: payload.incidentId, tenantId },
          });
          if (!incident) {
            await ctrl.ack();
            return;
          }
          const tenant = await this.prisma.tenant.findFirst({
            where: { id: tenantId },
          });
          const enrichment = await this.enrichment.find(
            tenantId,
            payload.incidentId,
          );
          const context = this.contextBuilder.build(
            incident,
            enrichment,
            tenant?.slug,
          );
          await this.orchestrator.trigger({
            tenantId,
            incidentId: payload.incidentId,
            context,
            trigger: 'auto',
            correlationId: msg.headers.correlationId,
            tenantSlug: tenant?.slug,
          });
          await ctrl.ack();
        } catch (error) {
          this.logger.log(
            `aiops investigation auto trigger failed tenantId=${tenantId} incidentId=${payload.incidentId} error=${error instanceof Error ? error.message : 'unknown'}`,
          );
          await ctrl.ack();
        }
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscription?.unsubscribe();
  }
}
