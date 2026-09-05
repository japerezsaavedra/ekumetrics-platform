import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertmanagerService } from '../alertmanager/alertmanager.service';
import { MetricsService } from '../observability/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { CorrelationMetrics } from './correlation-metrics';
import { scoreCluster } from './correlation-score';
import type {
  ClusterCorrelation,
  CorrelateAlert,
  CorrelationEvidence,
  IncidentCorrelationMembers,
} from './correlation-types';
import {
  loadCorrelationHops,
  loadCorrelationWeights,
  loadCorrelationWindowMs,
  type CorrelationWeights,
} from './correlation-weights';
import { commonCover, sharePath, walk } from './graph-walk';
import { GraphService } from './graph.service';
import { TopologyCorrelationService } from './topology-correlation/topology-correlation.service';
import type { TopologyClusterEnrichment } from './topology-correlation/topology-correlation.types';

export type { CorrelateAlert } from './correlation-types';
export type {
  ClusterCorrelation,
  CorrelationEvidence,
  CorrelationScore,
  IncidentCorrelationMembers,
} from './correlation-types';

const RANK = ['critical', 'error', 'warning', 'info', 'unknown'];

type ResolvedAlert = { alert: CorrelateAlert; nodeKey: string | null };

type CollectorEventRef = {
  fingerprint: string;
  signal: string;
  assetKey: string | null;
  siteId: string;
};

@Injectable()
export class CorrelationService {
  private readonly logger = new Logger(CorrelationService.name);
  private readonly weights: CorrelationWeights;
  private readonly windowMs: number;
  private readonly hops: number;
  private readonly metrics: CorrelationMetrics;
  private readonly topologyCorrelation?: TopologyCorrelationService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    private readonly alertmanager: AlertmanagerService,
    private readonly config: ConfigService,
    @Optional() metrics?: CorrelationMetrics,
    @Optional() platformMetrics?: MetricsService,
    @Optional() topologyCorrelation?: TopologyCorrelationService,
  ) {
    const read = (key: string) => this.config.get<string>(key);
    this.weights = loadCorrelationWeights(read);
    this.windowMs = loadCorrelationWindowMs(read);
    this.hops = loadCorrelationHops(read);
    this.metrics = metrics ?? new CorrelationMetrics();
    this.topologyCorrelation = topologyCorrelation;
    platformMetrics?.registerContributor('aiops-correlation', () =>
      this.metrics.render(),
    );
  }

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
    if (!nodeKey) return { origin: null, hops: 3, nodes: [], edges: [] };
    return this.graph.impact(tenant.id, nodeKey);
  }

  async snapshot(tenantSlug: string, siteId?: string) {
    const tenant = await this.requireTenant(tenantSlug);
    return this.graph.snapshot(tenant.id, siteId || undefined);
  }

  async seedExample(tenantSlug: string, siteId?: string) {
    const tenant = await this.requireTenant(tenantSlug);
    let site = siteId?.trim() || '';
    if (!site) {
      const row = await this.prisma.site.findFirst({
        where: { tenantId: tenant.id },
        orderBy: { name: 'asc' },
      });
      site = row?.id ?? '';
    }
    if (!site) {
      throw new BadRequestException(
        'Cree un sitio antes de cargar la topología de ejemplo.',
      );
    }
    return this.graph.seedExample(tenant.id, site);
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
    const started = process.hrtime.bigint();
    let created = 0;
    let updated = 0;
    try {
      const unique = this.dedupeByFingerprint(alerts);
      if (unique.length === 0) {
        return { tenant: tenantSlug, created: 0, updated: 0, incidents: [] };
      }
      const siteIds = [...new Set(unique.map((alert) => alert.siteId || ''))];
      const edgesBySite = new Map(
        await Promise.all(
          siteIds.map(async (siteId) => {
            const links = await this.graph.links(tenantId, siteId || undefined);
            return [siteId, links] as const;
          }),
        ),
      );
      const collectorByFingerprint = await this.collectorEventsByFingerprint(
        tenantId,
        unique.map((alert) => alert.fingerprint),
      );
      const resolved = await Promise.all(
        unique.map(async (alert) => ({
          alert,
          nodeKey: await this.resolveNode(
            tenantId,
            alert,
            collectorByFingerprint.get(alert.fingerprint),
          ),
        })),
      );
      const grouped = this.cluster(resolved, edgesBySite);
      const applied = this.topologyCorrelation
        ? await this.topologyCorrelation.apply({
            tenantId,
            tenantSlug,
            clusters: grouped,
            hops: this.hops,
            windowMs: this.windowMs,
          })
        : {
            clusters: grouped,
            enrichments: grouped.map(() => null),
            suppressions: 0,
          };
      const incidents = [];
      for (let index = 0; index < applied.clusters.length; index += 1) {
        const saved = await this.persist(
          tenantId,
          tenantSlug,
          applied.clusters[index],
          edgesBySite,
          collectorByFingerprint,
          applied.enrichments[index] ?? null,
        );
        if (saved.created) created += 1;
        else updated += 1;
        incidents.push(saved.incident);
      }
      return { tenant: tenantSlug, created, updated, incidents };
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;
      this.metrics.record(durationSeconds, created, updated);
      this.logger.log(
        `aiops correlation completed tenant=${tenantSlug} created=${created} updated=${updated} duration_s=${durationSeconds.toFixed(3)}`,
      );
    }
  }

  renderMetrics(): string {
    return this.metrics.render();
  }

  private cluster(
    items: ResolvedAlert[],
    edgesBySite: Map<string, { fromKey: string; toKey: string }[]>,
  ) {
    const groups: ResolvedAlert[][] = [];
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
    left: ResolvedAlert,
    right: ResolvedAlert,
    edgesBySite: Map<string, { fromKey: string; toKey: string }[]>,
  ): boolean {
    if ((left.alert.siteId || '') !== (right.alert.siteId || '')) return false;
    if (!this.sameWindow(left.alert.startsAt, right.alert.startsAt)) {
      return false;
    }
    const edges = edgesBySite.get(left.alert.siteId || '') ?? [];
    if (left.nodeKey && right.nodeKey) {
      return sharePath(left.nodeKey, right.nodeKey, edges, this.hops);
    }
    return true;
  }

  private sameWindow(left?: string | null, right?: string | null): boolean {
    const a = left ? Date.parse(left) : NaN;
    const b = right ? Date.parse(right) : NaN;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
    return Math.abs(a - b) <= this.windowMs;
  }

  private async persist(
    tenantId: string,
    tenantSlug: string,
    cluster: ResolvedAlert[],
    edgesBySite: Map<string, { fromKey: string; toKey: string }[]>,
    collectorByFingerprint: Map<string, CollectorEventRef>,
    enrichment: TopologyClusterEnrichment | null,
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
    let causeKey = commonCover(nodeKeys, edges, this.hops);
    if (
      enrichment?.suppression.applied &&
      enrichment.suppression.rootCauseKey
    ) {
      causeKey = enrichment.suppression.rootCauseKey;
    } else if (!causeKey && enrichment?.topologyEvidence.commonAncestorKey) {
      causeKey = enrichment.topologyEvidence.commonAncestorKey;
    }
    const cause = causeKey
      ? await this.graph.nodeByKey(tenantId, causeKey)
      : null;
    const impact = causeKey
      ? [...walk(causeKey, edges, this.hops)].filter((key) => key !== causeKey)
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
    const historical = await this.historicalSignal(
      tenantId,
      clusterKey,
      causeKey,
    );
    let correlation = scoreCluster({
      items: cluster,
      edges,
      windowMs: this.windowMs,
      hops: this.hops,
      weights: this.weights,
      historical,
    });
    if (enrichment && this.topologyCorrelation) {
      correlation = this.topologyCorrelation.attachToCorrelation(
        correlation,
        enrichment,
      );
    }
    const collectorEvents = fingerprints
      .map((fingerprint) => collectorByFingerprint.get(fingerprint))
      .filter((row): row is CollectorEventRef => Boolean(row))
      .map((row) => ({
        fingerprint: row.fingerprint,
        signal: row.signal,
        assetKey: row.assetKey,
      }));
    if (collectorEvents.length > 0) {
      this.prependDedupEvidence(correlation, collectorEvents.length);
    }
    const members: IncidentCorrelationMembers = {
      alerts: alerts.map((alert) => ({
        fingerprint: alert.fingerprint,
        name: alert.name,
        severity: alert.severity,
        nodeHint: alert.nodeHint ?? null,
      })),
      impact,
      correlation,
      collectorEvents,
      ...(enrichment
        ? {
            blastRadius: enrichment.blastRadius,
            suppression: enrichment.suppression,
            topologyEvidence: enrichment.topologyEvidence,
          }
        : {}),
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
      await this.publishTopology(
        tenantId,
        tenantSlug,
        clusterKey,
        incident.id,
        siteId,
        enrichment,
      );
      return { created: false, incident };
    }
    const incident = await this.prisma.incident.create({
      data: { tenantId, ...data },
    });
    await this.publishTopology(
      tenantId,
      tenantSlug,
      clusterKey,
      incident.id,
      siteId,
      enrichment,
    );
    return { created: true, incident };
  }

  private async publishTopology(
    tenantId: string,
    tenantSlug: string,
    clusterKey: string,
    incidentId: string,
    siteId: string | null,
    enrichment: TopologyClusterEnrichment | null,
  ) {
    if (!this.topologyCorrelation || !enrichment) return;
    await this.topologyCorrelation.publish({
      tenantId,
      tenantSlug,
      clusterKey,
      incidentId,
      siteId,
      enrichment,
    });
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
      labels: alert.labels,
    };
  }

  private async resolveNode(
    tenantId: string,
    alert: CorrelateAlert,
    collector?: CollectorEventRef,
  ) {
    if (alert.nodeHint) {
      const node = await this.graph.matchNode(
        tenantId,
        alert.siteId || undefined,
        alert.nodeHint,
      );
      if (node?.nodeKey) return node.nodeKey;
    }
    if (collector?.assetKey) {
      const node = await this.graph.matchNode(
        tenantId,
        alert.siteId || collector.siteId || undefined,
        collector.assetKey,
      );
      return node?.nodeKey ?? null;
    }
    return null;
  }

  private async requireTenant(slug: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug } });
    if (!tenant) {
      throw new NotFoundException('El tenant no existe.');
    }
    return tenant;
  }

  private dedupeByFingerprint(alerts: CorrelateAlert[]): CorrelateAlert[] {
    const seen = new Set<string>();
    const unique: CorrelateAlert[] = [];
    for (const alert of alerts) {
      const fingerprint = alert.fingerprint?.trim() ?? '';
      if (!fingerprint) {
        unique.push(alert);
        continue;
      }
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      unique.push(alert);
    }
    return unique;
  }

  private async collectorEventsByFingerprint(
    tenantId: string,
    fingerprints: string[],
  ) {
    const keys = fingerprints.filter(Boolean);
    const rows =
      keys.length === 0
        ? []
        : await this.prisma.agentEvent.findMany({
            where: { tenantId, fingerprint: { in: keys } },
            select: {
              fingerprint: true,
              signal: true,
              assetKey: true,
              siteId: true,
            },
          });
    return new Map<string, CollectorEventRef>(
      rows.map((row) => [
        row.fingerprint,
        {
          fingerprint: row.fingerprint,
          signal: row.signal,
          assetKey: row.assetKey,
          siteId: row.siteId,
        },
      ]),
    );
  }

  private async historicalSignal(
    tenantId: string,
    clusterKey: string,
    causeKey: string | null,
  ) {
    const [priorSameCluster, priorSimilarCause] = await Promise.all([
      this.prisma.incident.count({
        where: {
          tenantId,
          clusterKey,
          status: { in: ['resolved', 'closed'] },
        },
      }),
      causeKey
        ? this.prisma.incident.count({
            where: {
              tenantId,
              causeKey,
              NOT: { clusterKey },
            },
          })
        : Promise.resolve(0),
    ]);
    return { priorSameCluster, priorSimilarCause };
  }

  private prependDedupEvidence(
    correlation: ClusterCorrelation,
    matched: number,
  ) {
    const evidence: CorrelationEvidence = {
      kind: 'dedup',
      statement: `Fingerprint coincidente con ${matched} evento(s) persistido(s) del recolector`,
      score: 1,
      details: { matchedCollectorEvents: matched },
    };
    correlation.details.unshift(evidence);
    correlation.evidence.unshift(evidence.statement);
  }
}
