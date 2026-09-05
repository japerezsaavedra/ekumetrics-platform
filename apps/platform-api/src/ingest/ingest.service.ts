import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GraphService } from '../aiops/graph.service';
import { PrismaService } from '../prisma/prisma.service';
import { type EkmsEvent, parseEventBatch } from './ingest.types';
import { EventSubjects, buildHeaders } from '../messaging';
import { EventOutboxService } from '../messaging/event-outbox.service';
import type { EventsIngestedPayload } from '../aiops/contracts/events';

const ASSET_SIGNALS = new Set([
  'asset_discovered',
  'asset_updated',
  'asset_stale',
  'mac_changed',
]);
const CERTIFICATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type AgentCertificateIdentity = {
  tenantId: string;
  siteId: string;
  agentId: string;
};

export function parseAgentCertificateDn(
  distinguishedName: string,
): AgentCertificateIdentity | null {
  const attributes = new Map<string, string>();
  for (const component of distinguishedName.split(',')) {
    const separator = component.indexOf('=');
    if (separator < 1) return null;
    const key = component.slice(0, separator).trim().toUpperCase();
    const value = component.slice(separator + 1).trim();
    if (attributes.has(key) || !CERTIFICATE_ID_PATTERN.test(value)) return null;
    attributes.set(key, value);
  }
  const tenantId = attributes.get('O');
  const siteId = attributes.get('OU');
  const agentId = attributes.get('CN');
  return tenantId && siteId && agentId ? { tenantId, siteId, agentId } : null;
}

@Injectable()
export class IngestService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    @Optional() private readonly outbox?: EventOutboxService,
  ) {}

  async ingest(
    body: unknown,
    providedKey?: string,
    clientDn?: string,
    edgeAssertion?: string,
  ) {
    this.authorize(providedKey);
    const events = parseEventBatch(body);
    const identity = events[0];
    this.authorizeProductionEdge(identity, clientDn, edgeAssertion);
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: identity.tenantId },
    });
    if (!tenant) {
      throw new ForbiddenException('Identidad de agente no autorizada');
    }
    const [site, agent] = await Promise.all([
      this.prisma.site.findUnique({
        where: {
          tenantId_slug: { tenantId: tenant.id, slug: identity.siteId },
        },
      }),
      this.prisma.agent.findUnique({
        where: {
          tenantId_agentId: { tenantId: tenant.id, agentId: identity.agentId },
        },
      }),
    ]);
    if (!site || !agent || agent.siteId !== site.slug) {
      throw new ForbiddenException('Identidad de agente no autorizada');
    }

    const eventRows = events.map((event) => ({
      fingerprint: this.fingerprint(event),
      tenantId: tenant.id,
      agentId: agent.id,
      siteId: event.siteId,
      assetKey: event.assetId,
      assetType: event.assetType,
      vendor: event.vendor,
      tier: event.tier,
      signal: event.signal,
      value: event.value,
      unit: event.unit,
      severity: event.severity,
      source: event.source,
      tags: event.tags,
      category: event.category,
      entityType: event.entityType,
      correlationKey: event.correlationKey,
      environment: event.environment,
      traceId: event.traceId,
      metadata: event.metadata,
      eventAt: event.timestamp,
    }));
    const accepted = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.agentEvent.createManyAndReturn({
          data: eventRows,
          skipDuplicates: true,
          select: {
            id: true,
            fingerprint: true,
            tenantId: true,
            siteId: true,
            agentId: true,
            assetKey: true,
            assetType: true,
            signal: true,
            value: true,
            unit: true,
            category: true,
            entityType: true,
            environment: true,
            eventAt: true,
            metadata: true,
            tags: true,
            source: true,
          },
        });
        const inserted = new Set(created.map((row) => row.fingerprint));
        const acceptedAssetEvents = events
          .map((event, index) => ({
            event,
            fingerprint: eventRows[index].fingerprint,
          }))
          .filter(
            ({ event, fingerprint }) =>
              inserted.has(fingerprint) &&
              event.assetId &&
              ASSET_SIGNALS.has(event.signal),
          )
          .map(({ event }) => event)
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        for (const event of acceptedAssetEvents) {
          const current = await tx.asset.findUnique({
            where: {
              tenantId_assetKey: {
                tenantId: tenant.id,
                assetKey: event.assetId!,
              },
            },
          });
          const data = {
            agentId: agent.id,
            assetType: event.assetType,
            vendor: event.vendor,
            status: event.signal === 'asset_stale' ? 'stale' : 'known',
            lastObservedAt: event.timestamp,
          };
          if (!current) {
            await tx.asset.create({
              data: { tenantId: tenant.id, assetKey: event.assetId!, ...data },
            });
          } else if (
            !current.lastObservedAt ||
            current.lastObservedAt <= event.timestamp
          ) {
            await tx.asset.update({ where: { id: current.id }, data });
          }
        }
        await tx.agent.update({
          where: { id: agent.id },
          data: { lastSeenAt: new Date() },
        });
        if (this.outbox && created.length > 0) {
          const byFingerprint = new Map(
            events.map((event, index) => [
              eventRows[index].fingerprint,
              event,
            ]),
          );
          await this.outbox.enqueueMany(
            tx,
            created.map((row) =>
              toOutboxMessage(row, byFingerprint.get(row.fingerprint)),
            ),
          );
        }
        return created.length;
      },
      { isolationLevel: 'Serializable' },
    );
    await this.recordNeighbors(tenant.id, events);
    void this.outbox?.flush();
    return {
      status: 'accepted',
      received: events.length,
      accepted,
      duplicates: events.length - accepted,
    };
  }

  private async recordNeighbors(tenantId: string, events: EkmsEvent[]) {
    for (const event of events) {
      const neighborKey = event.tags.neighbor_key;
      if (
        event.signal !== 'neighbor_observed' ||
        !event.assetId ||
        !neighborKey
      ) {
        continue;
      }
      await this.graph.upsertNeighbor(tenantId, {
        siteId: event.siteId,
        fromKey: event.assetId,
        fromName: event.tags.name || event.assetId,
        fromKind: event.assetType || 'device',
        toKey: neighborKey,
        toName: event.tags.neighbor_name || neighborKey,
        toKind: event.tags.neighbor_type || 'device',
        source: event.tags.neighbor_source || event.source || 'lldp',
        seenAt: event.timestamp,
      });
    }
  }

  private authorize(providedKey?: string): void {
    const expected = this.config.get<string>('INGEST_SHARED_KEY')?.trim();
    if (!expected) {
      throw new UnauthorizedException('La ingesta no está configurada');
    }
    const provided = providedKey?.trim() ?? '';
    const expectedHash = createHash('sha256').update(expected).digest();
    const providedHash = createHash('sha256').update(provided).digest();
    if (!provided || !timingSafeEqual(expectedHash, providedHash)) {
      throw new UnauthorizedException('Credencial de ingesta inválida');
    }
  }

  private authorizeProductionEdge(
    identity: EkmsEvent,
    clientDn?: string,
    edgeAssertion?: string,
  ): void {
    if (this.config.get<string>('DEPLOYMENT_MODE') !== 'production') return;

    const expectedAssertion = this.config
      .get<string>('AGENT_EDGE_ASSERTION_KEY')
      ?.trim();
    const providedAssertion = edgeAssertion?.trim() ?? '';
    if (
      !expectedAssertion ||
      !providedAssertion ||
      !this.securelyEqual(expectedAssertion, providedAssertion)
    ) {
      throw new UnauthorizedException('Borde de ingesta no autorizado');
    }

    const certificate = clientDn ? parseAgentCertificateDn(clientDn) : null;
    if (
      !certificate ||
      certificate.tenantId !== identity.tenantId ||
      certificate.siteId !== identity.siteId ||
      certificate.agentId !== identity.agentId
    ) {
      throw new ForbiddenException('Certificado de agente no autorizado');
    }
  }

  private securelyEqual(expected: string, provided: string): boolean {
    const expectedHash = createHash('sha256').update(expected).digest();
    const providedHash = createHash('sha256').update(provided).digest();
    return timingSafeEqual(expectedHash, providedHash);
  }

  private fingerprint(event: EkmsEvent): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          timestamp: event.timestamp.toISOString(),
          tenant_id: event.tenantId,
          site_id: event.siteId,
          agent_id: event.agentId,
          asset_id: event.assetId ?? '',
          asset_type: event.assetType ?? '',
          vendor: event.vendor ?? '',
          tier: event.tier ?? null,
          signal: event.signal,
          value: event.value,
          unit: event.unit ?? '',
          severity: event.severity ?? '',
          source: event.source,
          tags: event.tags,
          ...event.fingerprintExtras,
        }),
      )
      .digest('hex');
  }
}

function toOutboxMessage(
  row: {
    id: string;
    fingerprint: string;
    tenantId: string;
    siteId: string;
    agentId: string;
    assetKey: string | null;
    assetType: string | null;
    signal: string;
    value: number;
    category: string | null;
    entityType: string | null;
    environment: string | null;
    eventAt: Date;
    metadata: unknown;
    tags: unknown;
  },
  original?: EkmsEvent,
) {
  const metadata = asRecord(row.metadata) ?? asRecord(original?.metadata);
  const tags = asStringMap(row.tags) ?? original?.tags ?? {};
  const labels = asStringMap(metadata?.labels);
  const entityId =
    optionalString(metadata?.entityId) ??
    optionalString(metadata?.entity_id) ??
    row.assetKey ??
    original?.assetId;
  const metricName =
    optionalString(metadata?.metricName) ??
    optionalString(metadata?.metric_name) ??
    original?.metadata?.metricName ??
    row.signal;
  const payload: EventsIngestedPayload = {
    tenantId: row.tenantId,
    agentEventId: row.id,
    fingerprint: row.fingerprint,
    siteId: row.siteId,
    agentId: row.agentId,
    entityId: entityId ?? undefined,
    entityType: row.entityType ?? original?.entityType ?? undefined,
    assetKey: row.assetKey ?? undefined,
    signal: row.signal,
    category: row.category ?? undefined,
    timestamp: row.eventAt.toISOString(),
    eventAt: row.eventAt.toISOString(),
    value: row.value,
    metricName,
    environment: row.environment ?? original?.environment,
    labels,
    attributes: asAttributeMap(metadata?.attributes),
    metadata: metadata ?? undefined,
    tags,
  };
  return {
    tenantId: row.tenantId,
    subject: EventSubjects.EVENTS_INGESTED,
    idempotencyKey: `${row.tenantId}:events.ingested:${row.id}`,
    payload,
    headers: buildHeaders({
      tenantId: row.tenantId,
      siteId: row.siteId,
      agentId: original?.agentId,
      correlationId: original?.traceId ?? row.id,
      producedBy: 'ingest-service',
      occurredAt: row.eventAt.toISOString(),
    }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const mapped: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') mapped[key] = item;
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function asAttributeMap(
  value: unknown,
): Record<string, string | number | boolean> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const mapped: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(record)) {
    if (
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      mapped[key] = item;
    }
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
