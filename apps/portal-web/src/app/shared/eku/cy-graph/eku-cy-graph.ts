import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import cytoscape from 'cytoscape';

export type CyGraphNode = {
  key: string;
  name: string;
  kind: string;
  role: 'cause' | 'alert' | 'impact' | 'node';
};

export type CyGraphEdge = {
  from: string;
  to: string;
};

@Component({
  selector: 'eku-cy-graph',
  templateUrl: './eku-cy-graph.html',
  styleUrl: './eku-cy-graph.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EkuCyGraphComponent {
  readonly nodes = input<CyGraphNode[]>([]);
  readonly edges = input<CyGraphEdge[]>([]);
  readonly selectedKey = input<string | null>(null);
  readonly rootKey = input<string | null>(null);
  readonly nodeSelected = output<string>();
  readonly nodeExpand = output<string>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly destroyRef = inject(DestroyRef);
  private cy: cytoscape.Core | null = null;
  private resize: ResizeObserver | null = null;
  private lastSignature = '';

  constructor() {
    afterNextRender(() => {
      const el = this.host().nativeElement;
      this.cy = cytoscape({
        container: el,
        minZoom: 0.15,
        maxZoom: 4,
        wheelSensitivity: 0.25,
        userZoomingEnabled: true,
        userPanningEnabled: true,
        boxSelectionEnabled: false,
        style: this.stylesheet(el),
        layout: { name: 'preset' },
      });
      this.cy.on('tap', 'node', (event) => {
        const id = event.target.id();
        if (id) this.nodeSelected.emit(id);
      });
      this.cy.on('dbltap', 'node', (event) => {
        const id = event.target.id();
        if (id) this.nodeExpand.emit(id);
      });
      this.sync(true);
      this.resize = new ResizeObserver(() => this.cy?.resize());
      this.resize.observe(el);
      this.destroyRef.onDestroy(() => {
        this.resize?.disconnect();
        this.cy?.destroy();
        this.cy = null;
      });
    });

    effect(() => {
      this.nodes();
      this.edges();
      this.rootKey();
      untracked(() => this.sync(false));
    });
    effect(() => {
      this.selectedKey();
      untracked(() => this.focus());
    });
  }

  protected zoomIn(): void {
    this.zoomBy(1.25);
  }

  protected zoomOut(): void {
    this.zoomBy(0.8);
  }

  protected fitView(): void {
    this.cy?.fit(undefined, 36);
  }

  protected pan(dx: number, dy: number): void {
    this.cy?.panBy({ x: dx * 80, y: dy * 80 });
  }

  private zoomBy(factor: number): void {
    if (!this.cy) return;
    const container = this.cy.container();
    if (!container) return;
    const next = Math.min(4, Math.max(0.15, this.cy.zoom() * factor));
    this.cy.zoom({
      level: next,
      renderedPosition: { x: container.clientWidth / 2, y: container.clientHeight / 2 },
    });
  }

  private sync(first: boolean): void {
    if (!this.cy) return;
    const nodes = this.nodes();
    const edges = this.edges();
    const signature = `${nodes.map((item) => item.key).join('|')}::${edges.map((item) => `${item.from}-${item.to}`).join('|')}::${this.rootKey() ?? ''}`;
    if (!first && signature === this.lastSignature) {
      this.styleRoles();
      this.focus();
      return;
    }
    this.lastSignature = signature;
    this.cy.elements().remove();
    this.cy.add([
      ...nodes.map((item) => ({
        data: {
          id: item.key,
          label: item.name,
          kind: item.kind,
          role: item.role,
        },
      })),
      ...edges
        .filter((edge) => nodes.some((item) => item.key === edge.from) && nodes.some((item) => item.key === edge.to))
        .map((edge) => ({
          data: {
            id: `${edge.from}__${edge.to}`,
            source: edge.from,
            target: edge.to,
          },
        })),
    ]);
    if (nodes.length) {
      const root = this.rootKey();
      const hasRoot = Boolean(root && this.cy.getElementById(root).nonempty());
      if (hasRoot && root) {
        this.cy
          .layout({
            name: 'breadthfirst',
            directed: false,
            animate: false,
            padding: 48,
            spacingFactor: 1.6,
            avoidOverlap: true,
            roots: [root],
          })
          .run();
      } else {
        this.cy
          .layout({
            name: 'cose',
            animate: false,
            randomize: first || nodes.length < 3,
            padding: 48,
            nodeOverlap: 24,
            componentSpacing: 110,
            nodeRepulsion: () => 12000,
            idealEdgeLength: () => 120,
          })
          .run();
      }
      this.cy.fit(undefined, 36);
    }
    this.focus();
  }

  private styleRoles(): void {
    if (!this.cy) return;
    for (const item of this.nodes()) {
      this.cy.getElementById(item.key).data('role', item.role);
    }
  }

  private focus(): void {
    if (!this.cy) return;
    const id = this.selectedKey();
    this.cy.elements().removeClass('is-on is-near is-dim');
    if (!id) return;
    const node = this.cy.getElementById(id);
    if (node.empty()) return;
    const near = node.closedNeighborhood();
    this.cy.elements().addClass('is-dim');
    near.removeClass('is-dim').addClass('is-near');
    node.addClass('is-on');
  }

  private stylesheet(el: HTMLElement): cytoscape.StylesheetJson {
    const token = (name: string, fallback: string) =>
      getComputedStyle(el).getPropertyValue(name).trim() || fallback;
    const primary = token('--eku-primary', '#441be4');
    const critical = token('--eku-critical', '#7a1f1f');
    const warning = token('--eku-warning', '#8a6d1f');
    const info = token('--eku-info', '#1d4e89');
    const healthy = token('--eku-healthy', '#1f5a32');
    const accent = token('--eku-accent', '#5f36b6');
    const text = token('--eku-text-primary', '#3a3c40');
    const surface = token('--eku-surface', '#ffffff');
    const border = token('--eku-border', '#dfe4ec');
    const font = token('--eku-font-sans', 'IBM Plex Sans, sans-serif');
    return [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          width: 36,
          height: 36,
          'background-color': info,
          'border-width': 2,
          'border-color': surface,
          color: text,
          'font-size': 12,
          'font-weight': 600,
          'font-family': font,
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 10,
          'text-wrap': 'wrap',
          'text-max-width': '110px',
          'text-background-color': surface,
          'text-background-opacity': 1,
          'text-background-padding': '4px',
        },
      },
      {
        selector: 'node[kind = "switch"]',
        style: { 'background-color': primary, width: 44, height: 44 },
      },
      {
        selector: 'node[kind = "host"]',
        style: { 'background-color': info },
      },
      {
        selector: 'node[kind = "service"]',
        style: { 'background-color': accent },
      },
      {
        selector: 'node[kind = "database"]',
        style: { 'background-color': healthy },
      },
      {
        selector: 'node[role = "cause"]',
        style: { 'border-width': 4, 'border-color': primary, width: 48, height: 48 },
      },
      {
        selector: 'node[role = "alert"]',
        style: { 'border-width': 4, 'border-color': critical },
      },
      {
        selector: 'node[role = "impact"]',
        style: { 'border-width': 3, 'border-color': warning },
      },
      {
        selector: 'node.is-on',
        style: { 'border-width': 5, 'border-color': primary },
      },
      {
        selector: 'node.is-dim',
        style: { opacity: 0.28 },
      },
      {
        selector: 'edge',
        style: {
          width: 2.5,
          'line-color': border,
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          'target-arrow-color': border,
          'arrow-scale': 0.85,
        },
      },
      {
        selector: 'edge.is-near',
        style: {
          width: 3.5,
          'line-color': primary,
          'target-arrow-color': primary,
        },
      },
      {
        selector: 'edge.is-dim',
        style: { opacity: 0.16 },
      },
    ];
  }
}
