import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { AlertmanagerService } from '../alertmanager/alertmanager.service';
import { PrismaService } from '../prisma/prisma.service';
import { commonCover, sharePath, walk } from './graph-walk';
import { GraphService } from './graph.service';

export type CorrelateAlert = {
  fingerprint: string;
  name: string;
  severity: string;
  siteId?: string;
  nodeHint?: string;
  startsAt?: string | null;
};

const WINDOW_MS = 5 * 60_000;
const HOPS = 4;
const RANK = ['critical', 'error', 'warning', 'info', 'unknown'];

@Injectable()
export class CorrelationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    private readonly alertmanager: AlertmanagerService,
  ) {}

  async list(tenantSlug: string) {
    const tenant = await this.requireTenant(tenantSlug);
    return this.prisma.incident.findMany({
      where: { tenantId: tenant.id },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  }

  async get(tenantSlug: string, id: string) {
    const tenant = await this.requireTenant(tenantSlug);
    const incident = await this.prisma.incident.findFirst({
      where: { id, tenantId: tenant.id },
    });
    if (!incident) {
      throw new NotFoundException('El incidente no existe.');
    }
    return incident;
  }

  async impact(tenantSlug: string, nodeKey: string) {
    const tenant = await this.requireTenant(tenantSlug);
    if (!nodeKey) return { origin: null, hops: 3, nodes: [] };
    return this.graph.impact(tenant.id, nodeKey);
  }

  async correlate(tenantSlug: string, includePlatform: boolean) {
    const tenant = await this.requireTenant(tenantSlug);
    const overview = await this.alertmanager.overview(
      tenantSlug,
      includePlatform,
    );
    const alerts = overview.alerts
      .filter((alert) => alert.state === 'active' || !alert.endsAt)
      .map((alert) => this.fromManaged(alert));
    return this.merge(tenant.id, tenantSlug, alerts);
  }

  async merge(tenantId: string, tenantSlug: string, alerts: CorrelateAlert[]) {
    if (alerts.length === 0) {
      return { tenant: tenantSlug, created: 0, updated: 0, incidents: [] };
    }
    const siteIds = [...new Set(alerts.map((alert) => alert.siteId || ''))];
    const edgesBySite = new Map(
      await Promise.all(
        siteIds.map(async (siteId) => {
          const links = await this.graph.links(tenantId, siteId || undefined);
          return [siteId, links] as const;
        }),
      ),
    );
    const resolved = await Promise.all(
      alerts.map(async (alert) => ({
        alert,
        nodeKey: await this.resolveNode(tenantId, alert),
      })),
    );
    const clusters = this.cluster(resolved, edgesBySite);
    let created = 0;
    let updated = 0;
    const incidents = [];
    for (const cluster of clusters) {
      const saved = await this.persist(tenantId, cluster, edgesBySite);
      if (saved.created) created += 1;
      else updated += 1;
      incidents.push(saved.incident);
    }
    return { tenant: tenantSlug, created, updated, incidents };
  }

  private cluster(
    items: { alert: CorrelateAlert; nodeKey: string | null }[],
    edgesBySite: Map<string, { fromKey: string; toKey: string }[]>,
  ) {
    const groups: { alert: CorrelateAlert; nodeKey: string | null }[][] = [];
    for (const item of items) {
      const host = groups.find((group) =>
        group.some((other) => this.sameCluster(item, other, edgesBySite)),
      );
      if (host) host.push(item);
      else groups.push([item]);
    }
    return groups;
  }

  private sameCluster(
    left: { alert: CorrelateAlert; nodeKey: string | null },
    right: { alert: CorrelateAlert; nodeKey: string | null },
    edgesBySite: Map<string, { fromKey: string; toKey: string }[]>,
  ): boolean {
    if ((left.alert.siteId || '') !== (right.alert.siteId || '')) return false;
    if (!this.sameWindow(left.alert.startsAt, right.alert.startsAt)) {
      return false;
    }
    const edges = edgesBySite.get(left.alert.siteId || '') ?? [];
    if (left.nodeKey && right.nodeKey) {
      return sharePath(left.nodeKey, right.nodeKey, edges, HOPS);
    }
    return true;
  }

  private sameWindow(left?: string | null, right?: string | null): boolean {
    const a = left ? Date.parse(left) : NaN;
    const b = right ? Date.parse(right) : NaN;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
    return Math.abs(a - b) <= WINDOW_MS;
  }

  private async persist(
    tenantId: string,
    cluster: { alert: CorrelateAlert; nodeKey: string | null }[],
    edgesBySite: Map<string, { fromKey: string; toKey: string }[]>,
  ) {
    const alerts = cluster.map((item) => item.alert);
    const fingerprints = alerts.map((alert) => alert.fingerprint).sort();
    const clusterKey = createHash('sha256')
      .update(fingerprints.join('|'))
      .digest('hex');
    const siteId = alerts[0]?.siteId || null;
    const edges = edgesBySite.get(siteId || '') ?? [];
    const nodeKeys = cluster
      .map((item) => item.nodeKey)
      .filter((key): key is string => Boolean(key));
    const causeKey = commonCover(nodeKeys, edges, HOPS);
    const cause = causeKey
      ? await this.graph.nodeByKey(tenantId, causeKey)
      : null;
    const impact = causeKey
      ? [...walk(causeKey, edges, HOPS)].filter((key) => key !== causeKey)
      : nodeKeys;
    const starts = alerts
      .map((alert) => (alert.startsAt ? Date.parse(alert.startsAt) : NaN))
      .filter((value) => Number.isFinite(value));
    const windowStart = starts.length ? new Date(Math.min(...starts)) : null;
    const windowEnd = starts.length ? new Date(Math.max(...starts)) : null;
    const confidence = this.confidence(Boolean(causeKey), nodeKeys.length);
    const severity = this.worst(alerts.map((alert) => alert.severity));
    const title = cause
      ? `Degradación de conectividad · ${cause.name}`
      : `Alertas correlacionadas${siteId ? ` · ${siteId}` : ''}`;
    const members = {
      alerts: alerts.map((alert) => ({
        fingerprint: alert.fingerprint,
        name: alert.name,
        severity: alert.severity,
        nodeHint: alert.nodeHint ?? null,
      })),
      impact,
    };
    const existing = await this.prisma.incident.findFirst({
      where: {
        tenantId,
        clusterKey,
        status: { in: ['open', 'acknowledged'] },
      },
    });
    const data = {
      title,
      severity,
      siteId,
      clusterKey,
      causeKey: cause?.nodeKey ?? causeKey,
      causeName: cause?.name ?? causeKey,
      confidence,
      windowStart,
      windowEnd,
      alertCount: alerts.length,
      eventCount: alerts.length,
      members,
    };
    if (existing) {
      const incident = await this.prisma.incident.update({
        where: { id: existing.id },
        data,
      });
      return { created: false, incident };
    }
    const incident = await this.prisma.incident.create({
      data: { tenantId, ...data },
    });
    return { created: true, incident };
  }

  private confidence(hasCause: boolean, linkedNodes: number): number {
    if (!hasCause) return linkedNodes > 1 ? 0.4 : 0.25;
    return Math.min(0.91, 0.7 + Math.min(linkedNodes, 4) * 0.05);
  }

  private worst(values: string[]): string {
    return (
      RANK.find((level) =>
        values.some((value) => value.toLowerCase() === level),
      ) ?? 'warning'
    );
  }

  private fromManaged(alert: {
    fingerprint: string;
    name: string;
    severity: string;
    labels: Record<string, string>;
    startsAt: string | null;
  }): CorrelateAlert {
    return {
      fingerprint: alert.fingerprint,
      name: alert.name,
      severity: alert.severity,
      siteId: alert.labels.site_id || alert.labels.site || '',
      nodeHint:
        alert.labels.asset_id ||
        alert.labels.instance ||
        alert.labels.agent_id ||
        alert.labels.ip ||
        '',
      startsAt: alert.startsAt,
    };
  }

  private async resolveNode(tenantId: string, alert: CorrelateAlert) {
    if (!alert.nodeHint) return null;
    const node = await this.graph.matchNode(
      tenantId,
      alert.siteId || undefined,
      alert.nodeHint,
    );
    return node?.nodeKey ?? null;
  }

  private async requireTenant(slug: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug } });
    if (!tenant) {
      throw new NotFoundException('El tenant no existe.');
    }
    return tenant;
  }
}
