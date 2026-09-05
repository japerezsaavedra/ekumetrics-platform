import { DatePipe } from '@angular/common';
import { HttpClient, HttpParams } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { forkJoin, startWith } from 'rxjs';
import { API_BASE_URL } from '../../core/api';
import { TenantService } from '../../core/tenant';
import {
  EkuCyGraphComponent,
  type CyGraphNode,
} from '../../shared/eku/cy-graph/eku-cy-graph';
import { EkuEmptyStateComponent } from '../../shared/eku/empty-state/eku-empty-state';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuLoadingSkeletonComponent } from '../../shared/eku/loading-skeleton/eku-loading-skeleton';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';
import { IncidentEnrichmentPanel } from '../incidents/incident-enrichment-panel';
import {
  enrichmentPriority,
  type IncidentEnrichmentDto,
} from '../incidents/incident-enrichment.view';
import {
  adjacency,
  shortestPath,
  walkKeys,
  type TopologyEdge,
  type TopologyNode,
} from '../correlacion/correlacion-tree';

type GraphNode = TopologyNode & { source: string; lastSeenAt: string };
type GraphSnapshot = {
  sites: string[];
  nodes: GraphNode[];
  edges: Array<TopologyEdge & { relation: string; source: string; siteId: string }>;
};

type IncidentAlert = {
  fingerprint: string;
  name: string;
  severity: string;
  nodeHint?: string | null;
};

type ManagedIncident = {
  id: string;
  title: string;
  status: string;
  severity: string;
  siteId: string | null;
  causeName: string | null;
  causeKey: string | null;
  confidence: number | null;
  alertCount: number;
  members: { alerts?: IncidentAlert[]; impact?: string[] } | null;
  enrichment?: IncidentEnrichmentDto | null;
  updatedAt: string;
};

type NodeRole = CyGraphNode['role'];

const ROLE_LABEL: Record<NodeRole, string> = {
  cause: 'Causa probable',
  alert: 'Alerta',
  impact: 'Impacto',
  node: 'Nodo',
};

@Component({
  selector: 'app-investigacion-page',
  imports: [
    DatePipe,
    ReactiveFormsModule,
    EkuCyGraphComponent,
    EkuEmptyStateComponent,
    EkuErrorStateComponent,
    EkuLoadingSkeletonComponent,
    EkuPageHeaderComponent,
    IncidentEnrichmentPanel,
  ],
  templateUrl: './investigacion-page.html',
  styleUrl: './investigacion-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InvestigacionPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly tenants = inject(TenantService);

  protected readonly loading = signal(true);
  protected readonly correlating = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly snapshot = signal<GraphSnapshot | null>(null);
  protected readonly incidents = signal<ManagedIncident[]>([]);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly pickedKey = signal<string | null>(null);
  protected readonly canvasKeys = signal<Set<string>>(new Set());

  protected readonly filters = this.fb.nonNullable.group({
    siteId: [''],
    query: [''],
  });
  private readonly filterValue = toSignal(
    this.filters.valueChanges.pipe(startWith(this.filters.getRawValue())),
    { initialValue: this.filters.getRawValue() },
  );

  protected readonly selected = computed(
    () => this.incidents().find((item) => item.id === this.selectedId()) ?? null,
  );
  protected readonly graphNodes = computed(() =>
    (this.snapshot()?.nodes ?? []).filter((node) => node.source !== 'example'),
  );
  protected readonly graphEdges = computed(() =>
    (this.snapshot()?.edges ?? []).filter((edge) => edge.source !== 'example'),
  );
  protected readonly causeKey = computed(() => {
    const keys = new Set(this.graphNodes().map((node) => node.key));
    const incident = this.selected();
    if (incident?.causeKey && keys.has(incident.causeKey)) return incident.causeKey;
    return null;
  });
  protected readonly impactKeys = computed(() => {
    const keys = new Set(this.graphNodes().map((node) => node.key));
    return (this.selected()?.members?.impact ?? []).filter((key) => keys.has(key));
  });
  protected readonly alertKeys = computed(() => {
    const alerts = this.selected()?.members?.alerts ?? [];
    if (!alerts.length) return [];
    return this.matchAlertNodes(alerts, this.graphNodes());
  });
  protected readonly catalog = computed(() => {
    const query = (this.filterValue().query ?? '').trim().toLowerCase();
    const on = this.canvasKeys();
    return this.graphNodes()
      .filter((node) => {
        if (!query) return true;
        return (
          node.name.toLowerCase().includes(query) ||
          node.kind.toLowerCase().includes(query) ||
          node.key.toLowerCase().includes(query)
        );
      })
      .map((node) => ({ ...node, onCanvas: on.has(node.key) }));
  });
  protected readonly canvasNodes = computed((): CyGraphNode[] => {
    const on = this.canvasKeys();
    return this.graphNodes()
      .filter((node) => on.has(node.key))
      .map((node) => ({
        key: node.key,
        name: node.name,
        kind: node.kind,
        role: this.roleOf(node.key),
      }));
  });
  protected readonly canvasEdges = computed(() => {
    const on = this.canvasKeys();
    return this.graphEdges().filter((edge) => on.has(edge.from) && on.has(edge.to));
  });
  protected readonly layoutRoot = computed(() => {
    const on = this.canvasKeys();
    const cause = this.causeKey();
    if (cause && on.has(cause)) return cause;
    return this.graphNodes().find((node) => on.has(node.key))?.key ?? null;
  });
  protected readonly inspector = computed(() => {
    const node = this.graphNodes().find((item) => item.key === this.pickedKey());
    if (!node) return null;
    const cause = this.causeKey();
    const edges = this.graphEdges();
    const byKey = new Map(this.graphNodes().map((item) => [item.key, item]));
    const on = this.canvasKeys();
    const role = this.roleOf(node.key);
    const neighborKeys = adjacency(edges).get(node.key) ?? [];
    const neighbors = neighborKeys
      .map((key) => byKey.get(key))
      .filter((item): item is GraphNode => Boolean(item))
      .map((item) => ({ ...item, onCanvas: on.has(item.key) }));
    const reach = [...walkKeys(node.key, edges, 3)].filter((key) => key !== node.key);
    const path = cause ? shortestPath(cause, node.key, edges) : null;
    const pending = neighbors.filter((item) => !item.onCanvas).length;
    return {
      node,
      role,
      roleLabel: ROLE_LABEL[role],
      hopsFromCause: path ? Math.max(path.length - 1, 0) : null,
      neighbors,
      pending,
      reachCount: reach.length,
      pathNodes: (path ?? [])
        .map((key) => byKey.get(key))
        .filter((item): item is GraphNode => Boolean(item)),
      relatedAlerts: this.relatedAlerts(node, reach, path ?? []),
      implication: this.implication(role, node.name, reach.length),
      siteLabel: this.siteLabel(node.siteId),
    };
  });
  protected readonly siteOptions = computed(() => {
    const named = this.tenants.current()?.sites ?? [];
    const extra = this.snapshot()?.sites ?? [];
    const seen = new Set(named.map((item) => item.id));
    return [
      ...named.map((item) => ({ id: item.id, label: item.name })),
      ...extra.filter((id) => !seen.has(id)).map((id) => ({ id, label: id })),
    ];
  });

  constructor() {
    this.filters.controls.siteId.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.canvasKeys.set(new Set());
      this.pickedKey.set(null);
      this.load();
    });
    effect(() => {
      this.tenants.slug();
      untracked(() => {
        this.filters.patchValue({ siteId: '', query: '' }, { emitEvent: false });
        this.canvasKeys.set(new Set());
        this.pickedKey.set(null);
        this.load();
      });
    });
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    const siteId = this.filters.controls.siteId.value;
    const params = siteId ? new HttpParams().set('site', siteId) : undefined;
    forkJoin({
      graph: this.http.get<GraphSnapshot>(`${API_BASE_URL}/v1/graph`, { params }),
      incidents: this.http.get<ManagedIncident[]>(`${API_BASE_URL}/v1/incidents`),
    }).subscribe({
      next: ({ graph, incidents }) => {
        this.snapshot.set(graph);
        const siteIncidents = siteId
          ? incidents.filter((item) => !item.siteId || item.siteId === siteId)
          : incidents;
        this.incidents.set(siteIncidents);
        const hero =
          siteIncidents.find((item) => item.id === this.selectedId()) ??
          siteIncidents.find((item) => item.causeKey) ??
          siteIncidents[0] ??
          null;
        if (!siteId && hero?.siteId) {
          this.filters.patchValue({ siteId: hero.siteId }, { emitEvent: false });
          this.selectedId.set(hero.id);
          this.load();
          return;
        }
        this.selectedId.set(hero?.id ?? null);
        this.showTopology();
        if (hero) this.selectIncident(hero);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.message ?? 'No se pudo cargar la investigación.');
        this.loading.set(false);
      },
    });
  }

  protected correlate(): void {
    this.correlating.set(true);
    this.error.set(null);
    this.http
      .post<{ created: number; updated: number }>(`${API_BASE_URL}/v1/incidents/correlate`, {})
      .subscribe({
        next: () => {
          this.correlating.set(false);
          this.load();
        },
        error: (err) => {
          this.error.set(err.error?.message ?? 'No se pudo correlacionar.');
          this.correlating.set(false);
        },
      });
  }

  protected showTopology(): void {
    const nodes = this.graphNodes();
    this.canvasKeys.set(new Set(nodes.map((node) => node.key)));
    const preferred = nodes.find((node) => node.key === this.causeKey()) ?? nodes[0];
    this.pickedKey.set(preferred?.key ?? null);
  }

  protected selectIncident(item: ManagedIncident): void {
    this.selectedId.set(item.id);
    const keys = [item.causeKey, ...(item.members?.impact ?? [])].filter(
      (key): key is string => Boolean(key),
    );
    this.addKeys(keys);
    this.pickedKey.set(item.causeKey ?? keys[0] ?? this.pickedKey());
  }

  protected addFromCatalog(key: string): void {
    this.addKeys([key]);
    this.pickedKey.set(key);
  }

  protected pickNode(key: string): void {
    if (!key) return;
    this.pickedKey.set(key);
  }

  protected expandNode(key: string): void {
    const next = adjacency(this.graphEdges()).get(key) ?? [];
    this.addKeys([key, ...next]);
    this.pickedKey.set(key);
  }

  protected clearCanvas(): void {
    this.canvasKeys.set(new Set());
    this.pickedKey.set(null);
  }

  protected roleOf(key: string): NodeRole {
    if (key === this.causeKey()) return 'cause';
    if (this.alertKeys().includes(key)) return 'alert';
    if (this.impactKeys().includes(key)) return 'impact';
    return 'node';
  }

  protected confidence(value: number | null): string {
    if (value == null) return 'Sin causa en el grafo';
    return `${Math.round(value * 100)} %`;
  }

  protected priorityOf(item: ManagedIncident): string | null {
    return enrichmentPriority(item.enrichment);
  }

  protected onEnrichmentFeedback(row: IncidentEnrichmentDto): void {
    this.incidents.update((current) =>
      current.map((item) =>
        item.id === this.selectedId() ? { ...item, enrichment: row } : item,
      ),
    );
  }

  private addKeys(keys: string[]): void {
    this.canvasKeys.update((current) => {
      const next = new Set(current);
      for (const key of keys) next.add(key);
      return next;
    });
  }

  private siteLabel(siteId: string): string {
    return this.siteOptions().find((item) => item.id === siteId)?.label ?? siteId;
  }

  private matchAlertNodes(alerts: IncidentAlert[], nodes: TopologyNode[]): string[] {
    const hints = alerts
      .map((alert) => alert.nodeHint)
      .filter((hint): hint is string => Boolean(hint));
    return nodes
      .filter(
        (node) =>
          hints.includes(node.key) ||
          hints.includes(node.name) ||
          hints.some((hint) => node.key.endsWith(`/${hint}`)),
      )
      .map((node) => node.key);
  }

  private relatedAlerts(node: TopologyNode, reach: string[], path: string[]): IncidentAlert[] {
    const incidentAlerts = this.selected()?.members?.alerts ?? [];
    if (!incidentAlerts.length) return [];
    return incidentAlerts.filter((alert) => {
      const hint = alert.nodeHint ?? '';
      if (!hint) return alert.name === node.name;
      return (
        hint === node.key ||
        hint === node.name ||
        node.key.endsWith(`/${hint}`) ||
        reach.includes(hint) ||
        path.includes(hint)
      );
    });
  }

  private implication(role: NodeRole, name: string, reachCount: number): string {
    if (role === 'cause') {
      return `${name} es el elemento común. Añada vecinos al grafo para ver qué cubre. Alcance: ${reachCount} equipos en 3 saltos.`;
    }
    if (role === 'alert') {
      return `Alerta del incidente. El camino hasta la causa explica por qué el motor no la trata como un fallo aislado.`;
    }
    if (role === 'impact') {
      return `${name} está en el radio de impacto. No es la causa, pero se vería afectado.`;
    }
    return `${name} está en la topología. Añádalo o expanda vecinos para seguir la investigación.`;
  }
}
