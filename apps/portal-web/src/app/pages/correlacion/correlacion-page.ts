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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { API_BASE_URL } from '../../core/api';
import { TenantService } from '../../core/tenant';
import { EkuEmptyStateComponent } from '../../shared/eku/empty-state/eku-empty-state';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuLoadingSkeletonComponent } from '../../shared/eku/loading-skeleton/eku-loading-skeleton';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';
import {
  adjacency,
  depthLevels,
  shortestPath,
  walkKeys,
  type TopologyEdge,
  type TopologyNode,
} from './correlacion-tree';

type GraphSnapshot = {
  sites: string[];
  nodes: Array<TopologyNode & { source: string; lastSeenAt: string }>;
  edges: Array<TopologyEdge & { relation: string; source: string; siteId: string }>;
};

type IncidentAlert = {
  fingerprint: string;
  name: string;
  severity: string;
  nodeHint?: string | null;
};

type IncidentMember = {
  alerts?: IncidentAlert[];
  impact?: string[];
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
  members: IncidentMember | null;
  updatedAt: string;
};

type NodeRole = 'cause' | 'alert' | 'impact' | 'node';

const EXAMPLE_NODES: TopologyNode[] = [
  { key: 'sw-core', name: 'Core switch', kind: 'switch', siteId: 'ejemplo', source: 'example' },
  { key: 'app-01', name: 'App 01', kind: 'host', siteId: 'ejemplo', source: 'example' },
  { key: 'app-02', name: 'App 02', kind: 'host', siteId: 'ejemplo', source: 'example' },
  { key: 'db-01', name: 'DB 01', kind: 'host', siteId: 'ejemplo', source: 'example' },
  { key: 'api-pagos', name: 'API Pagos', kind: 'service', siteId: 'ejemplo', source: 'example' },
  { key: 'sap', name: 'SAP', kind: 'service', siteId: 'ejemplo', source: 'example' },
  { key: 'postgres', name: 'PostgreSQL', kind: 'database', siteId: 'ejemplo', source: 'example' },
];

const EXAMPLE_EDGES: TopologyEdge[] = [
  { from: 'sw-core', to: 'app-01' },
  { from: 'sw-core', to: 'app-02' },
  { from: 'sw-core', to: 'db-01' },
  { from: 'app-01', to: 'api-pagos' },
  { from: 'app-02', to: 'sap' },
  { from: 'db-01', to: 'postgres' },
];

const ROLE_LABEL: Record<NodeRole, string> = {
  cause: 'Causa probable',
  alert: 'Alerta',
  impact: 'Impacto',
  node: 'Nodo',
};

@Component({
  selector: 'app-correlacion-page',
  imports: [
    DatePipe,
    ReactiveFormsModule,
    EkuEmptyStateComponent,
    EkuErrorStateComponent,
    EkuLoadingSkeletonComponent,
    EkuPageHeaderComponent,
  ],
  templateUrl: './correlacion-page.html',
  styleUrl: './correlacion-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CorrelacionPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly tenants = inject(TenantService);

  protected readonly loading = signal(true);
  protected readonly correlating = signal(false);
  protected readonly seeding = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly snapshot = signal<GraphSnapshot | null>(null);
  protected readonly incidents = signal<ManagedIncident[]>([]);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly pickedKey = signal<string | null>(null);
  protected readonly exampleOn = signal(false);

  protected readonly filters = this.fb.nonNullable.group({
    siteId: [''],
  });

  protected readonly selected = computed(
    () => this.incidents().find((item) => item.id === this.selectedId()) ?? null,
  );
  protected readonly graphNodes = computed(() =>
    this.exampleOn() ? EXAMPLE_NODES : (this.snapshot()?.nodes ?? []),
  );
  protected readonly graphEdges = computed(() =>
    this.exampleOn() ? EXAMPLE_EDGES : (this.snapshot()?.edges ?? []),
  );
  protected readonly demoRoles = computed(() => {
    if (this.selected()) return false;
    const keys = new Set(this.graphNodes().map((node) => node.key));
    return (
      this.exampleOn() ||
      ['sw-core', 'api-pagos', 'sap', 'postgres'].every((key) => keys.has(key))
    );
  });
  protected readonly causeKey = computed(() => {
    const keys = new Set(this.graphNodes().map((node) => node.key));
    const incident = this.selected();
    if (incident?.causeKey && keys.has(incident.causeKey)) return incident.causeKey;
    return this.demoRoles() ? 'sw-core' : (incident?.causeKey ?? null);
  });
  protected readonly impactKeys = computed(() => {
    const keys = new Set(this.graphNodes().map((node) => node.key));
    const incident = this.selected();
    const fromIncident = (incident?.members?.impact ?? []).filter((key) => keys.has(key));
    if (fromIncident.length) return fromIncident;
    return this.demoRoles()
      ? ['app-01', 'app-02', 'db-01', 'api-pagos', 'sap', 'postgres']
      : [];
  });
  protected readonly alertKeys = computed(() => {
    const nodes = this.graphNodes();
    const incident = this.selected();
    if (incident?.members?.alerts?.length) {
      const matched = this.matchAlertNodes(incident.members.alerts, nodes);
      if (matched.length) return matched;
    }
    return this.demoRoles() ? ['api-pagos', 'sap', 'postgres'] : [];
  });
  protected readonly levels = computed(() =>
    depthLevels(this.causeKey(), this.graphNodes(), this.graphEdges()),
  );
  protected readonly pathKeys = computed(() => {
    const cause = this.causeKey();
    const picked = this.pickedKey();
    if (!cause || !picked) return new Set<string>();
    const path = shortestPath(cause, picked, this.graphEdges());
    return new Set(path ?? []);
  });
  protected readonly picked = computed(
    () => this.graphNodes().find((node) => node.key === this.pickedKey()) ?? null,
  );
  protected readonly inspector = computed(() => {
    const node = this.picked();
    if (!node) return null;
    const cause = this.causeKey();
    const edges = this.graphEdges();
    const nodes = this.graphNodes();
    const byKey = new Map(nodes.map((item) => [item.key, item]));
    const role = this.roleOf(node.key);
    const neighborKeys = adjacency(edges).get(node.key) ?? [];
    const neighbors = neighborKeys
      .map((key) => byKey.get(key))
      .filter((item): item is TopologyNode => Boolean(item));
    const reach = [...walkKeys(node.key, edges, 3)].filter((key) => key !== node.key);
    const path = cause ? shortestPath(cause, node.key, edges) : null;
    const incidentAlerts = this.selected()?.members?.alerts ?? [];
    const relatedAlerts = this.demoRoles()
      ? this.alertKeys()
          .filter((key) => key === node.key || reach.includes(key) || path?.includes(key))
          .map((key) => ({
            fingerprint: key,
            name: byKey.get(key)?.name ?? key,
            severity: 'warning',
          }))
      : incidentAlerts.filter((alert) =>
          this.alertTouchesNode(alert, node, reach, path ?? []),
        );
    return {
      node,
      role,
      roleLabel: ROLE_LABEL[role],
      hopsFromCause: path ? Math.max(path.length - 1, 0) : null,
      neighbors,
      reachCount: reach.length,
      pathNodes: (path ?? []).map((key) => byKey.get(key)).filter((item): item is TopologyNode => Boolean(item)),
      relatedAlerts,
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
      this.load();
    });
    effect(() => {
      this.tenants.slug();
      untracked(() => {
        this.filters.patchValue({ siteId: '' }, { emitEvent: false });
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
        this.exampleOn.set(graph.nodes.length === 0);
        const siteIncidents = siteId
          ? incidents.filter((item) => !item.siteId || item.siteId === siteId)
          : incidents;
        this.incidents.set(siteIncidents);
        if (!siteIncidents.some((item) => item.id === this.selectedId())) {
          this.selectedId.set(siteIncidents[0]?.id ?? null);
        }
        const selected = siteIncidents.find((item) => item.id === this.selectedId());
        this.pickedKey.set(
          selected?.causeKey ??
            (graph.nodes.some((node) => node.key === 'sw-core')
              ? 'sw-core'
              : (graph.nodes[0]?.key ?? 'sw-core')),
        );
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.message ?? 'No se pudo cargar la correlación.');
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

  protected seedExample(): void {
    this.seeding.set(true);
    this.error.set(null);
    const siteId = this.filters.controls.siteId.value;
    const params = siteId ? new HttpParams().set('site', siteId) : undefined;
    this.http.post<GraphSnapshot>(`${API_BASE_URL}/v1/graph/example`, {}, { params }).subscribe({
      next: (graph) => {
        this.snapshot.set(graph);
        this.exampleOn.set(false);
        this.pickedKey.set(graph.nodes.find((node) => node.key === 'sw-core')?.key ?? graph.nodes[0]?.key ?? null);
        this.seeding.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.message ?? 'No se pudo cargar el ejemplo.');
        this.seeding.set(false);
      },
    });
  }

  protected select(item: ManagedIncident): void {
    this.selectedId.set(item.id);
    this.pickedKey.set(item.causeKey ?? this.pickedKey());
  }

  protected pickNode(key: string): void {
    this.pickedKey.set(key);
  }

  protected roleOf(key: string): NodeRole {
    if (key === this.causeKey()) return 'cause';
    if (this.alertKeys().includes(key)) return 'alert';
    if (this.impactKeys().includes(key)) return 'impact';
    return 'node';
  }

  protected roleLabel(key: string): string {
    return ROLE_LABEL[this.roleOf(key)];
  }

  protected confidence(value: number | null): string {
    if (value == null) return this.demoRoles() ? 'Ejemplo · 85 %' : 'Sin causa en el grafo';
    return `${Math.round(value * 100)} %`;
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

  private alertTouchesNode(
    alert: IncidentAlert,
    node: TopologyNode,
    reach: string[],
    path: string[],
  ): boolean {
    const hint = alert.nodeHint ?? '';
    if (!hint) return alert.name === node.name;
    return (
      hint === node.key ||
      hint === node.name ||
      node.key.endsWith(`/${hint}`) ||
      reach.includes(hint) ||
      path.includes(hint)
    );
  }

  private implication(role: NodeRole, name: string, reachCount: number): string {
    if (role === 'cause') {
      return `${name} es el elemento común. Si se degrada, el motor alcanza ${reachCount} equipos en hasta 3 saltos y agrupa ${this.alertKeys().length} alertas.`;
    }
    if (role === 'alert') {
      return `Aquí aparece una alerta del incidente. El camino hasta la causa está a la derecha: es por eso que el motor las junta y no las trata como fallos aislados.`;
    }
    if (role === 'impact') {
      return `${name} queda en el radio de impacto. No es la causa, pero se vería afectado si el nodo de arriba falla.`;
    }
    return `${name} está en la topología, fuera del incidente actual. Tiene vecinos LLDP y puede entrar en la correlación cuando haya alertas.`;
  }
}
