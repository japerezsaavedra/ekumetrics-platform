import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GraphService } from '../aiops/graph.service';
import { PrismaService } from '../prisma/prisma.service';
import { type EkmsEvent, parseEventBatch } from './ingest.types';

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
      eventAt: event.timestamp,
    }));
    const accepted = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.agentEvent.createManyAndReturn({
          data: eventRows,
          skipDuplicates: true,
          select: { fingerprint: true },
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
        return created.length;
      },
      { isolationLevel: 'Serializable' },
    );
    await this.recordNeighbors(tenant.id, events);
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
      if (event.signal !== 'neighbor_observed' || !event.assetId || !neighborKey) {
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
        }),
      )
      .digest('hex');
  }
}
