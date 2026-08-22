import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { API_BASE_URL } from '../../core/api';
import { TenantService } from '../../core/tenant';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';

const FALLBACK_VERSION = '1.4.0';
const RELEASES_REPO = 'japerezsaavedra/ekumetrics-agent-releases';
const RELEASES_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases`;

type GithubAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

function versionFromTag(tag: string): string {
  return tag.trim().replace(/^v/i, '');
}

function catalogAssets(version: string): GithubAsset[] {
  const base = `https://github.com/${RELEASES_REPO}/releases/download/v${version}`;
  return [
    {
      name: `ekumetrics-agent_${version}-1_amd64.deb`,
      browser_download_url: `${base}/ekumetrics-agent_${version}-1_amd64.deb`,
      size: 0,
    },
    {
      name: `ekumetrics-agent-${version}-1.x86_64.rpm`,
      browser_download_url: `${base}/ekumetrics-agent-${version}-1.x86_64.rpm`,
      size: 0,
    },
    {
      name: `ekumetrics-agent-${version}-linux-amd64.tar.gz`,
      browser_download_url: `${base}/ekumetrics-agent-${version}-linux-amd64.tar.gz`,
      size: 0,
    },
  ];
}

type GithubRelease = {
  tag_name: string;
  name: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: GithubAsset[];
};

type AgentModule = {
  key: string;
  name: string;
  icon: string;
  capability: string;
  onByDefault: boolean;
};

type ModuleGroup = {
  id: string;
  label: string;
  modules: AgentModule[];
};

type InstallerCard = {
  id: string;
  title: string;
  os: string;
  hint: string;
  icon: string;
  badge: string;
  command: string;
  asset: GithubAsset | null;
};

const MODULE_GROUPS: ModuleGroup[] = [
  {
    id: 'host',
    label: 'Este servidor',
    modules: [
      {
        key: 'metrics.host',
        name: 'Host',
        icon: 'memory',
        capability: 'CPU, memoria, disco, filesystem, load y NICs de esta máquina.',
        onByDefault: true,
      },
      {
        key: 'metrics.processes',
        name: 'Procesos',
        icon: 'account_tree',
        capability: 'CPU, memoria y E/S de procesos listados en names.',
        onByDefault: false,
      },
      {
        key: 'logs',
        name: 'Logs',
        icon: 'description',
        capability: 'journald, Event Log, ficheros o logs OTLP de esta maquina.',
        onByDefault: false,
      },
    ],
  },
  {
    id: 'sede',
    label: 'Componentes de sede',
    modules: [
      {
        key: 'snmp.devices',
        name: 'SNMP',
        icon: 'router',
        capability: 'Cualquier dispositivo v2c/v3 (puerto 161). Se declara en snmp.devices. Perfiles if-mib, host-mib, ups e icewarp.',
        onByDefault: false,
      },
      {
        key: 'databases',
        name: 'Bases de datos',
        icon: 'storage',
        capability: 'PostgreSQL, MySQL, Redis y MongoDB. Cuenta de solo lectura.',
        onByDefault: false,
      },
      {
        key: 'queues',
        name: 'Colas',
        icon: 'hub',
        capability: 'Kafka, RabbitMQ y NATS. No lee el payload de los mensajes.',
        onByDefault: false,
      },
      {
        key: 'icewarp',
        name: 'IceWarp',
        icon: 'mail',
        capability: 'MIB propia en puerto 1161, probes SMTP/IMAP/HTTPS y logs.',
        onByDefault: false,
      },
    ],
  },
  {
    id: 'sap',
    label: 'SAP (sensor)',
    modules: [
      {
        key: 'sap',
        name: 'Canal SAP',
        icon: 'lan',
        capability: 'Solo en mode: sensor (SPAN/PCAP o TAP). Sesiones, bytes, RTT y retransmisiones. No va en el YAML de sede.',
        onByDefault: false,
      },
      {
        key: 'sap.decode.authorized',
        name: 'Decode SAP',
        icon: 'policy',
        capability: 'Clasifica DIAG, RFC y Message Server solo en claro y con permiso. No descifra SNC/TLS.',
        onByDefault: false,
      },
      {
        key: 'sap.work',
        name: 'Trabajo SAP',
        icon: 'assignment',
        capability: 'Transacción y usuario seudonimizado desde un fichero JSONL autorizado.',
        onByDefault: false,
      },
    ],
  },
  {
    id: 'apps',
    label: 'Aplicaciones',
    modules: [
      {
        key: 'metrics.scrape',
        name: 'Scrape',
        icon: 'query_stats',
        capability: 'Recolecta /metrics Prometheus de los jobs declarados.',
        onByDefault: false,
      },
      {
        key: 'metrics.otlp',
        name: 'Métricas OTLP',
        icon: 'input',
        capability: 'Recibe métricas de aplicaciones en :4317 / :4318.',
        onByDefault: false,
      },
      {
        key: 'traces',
        name: 'Trazas',
        icon: 'timeline',
        capability: 'Trazas OTLP de aplicaciones instrumentadas.',
        onByDefault: false,
      },
    ],
  },
  {
    id: 'ingest',
    label: 'Ingesta de red',
    modules: [
      {
        key: 'ingest.syslog',
        name: 'Syslog',
        icon: 'cell_tower',
        capability: 'Escucha syslog UDP/TCP de equipos de la sede.',
        onByDefault: false,
      },
      {
        key: 'ingest.netflow',
        name: 'NetFlow',
        icon: 'swap_horiz',
        capability: 'NetFlow v5 (metadatos). v9/IPFIX se cuentan, no se decodifican.',
        onByDefault: false,
      },
      {
        key: 'ingest.traps',
        name: 'Traps SNMP',
        icon: 'notification_important',
        capability: 'Recibe traps. coldStart es info; linkDown es warning.',
        onByDefault: false,
      },
    ],
  },
  {
    id: 'inventory',
    label: 'Inventario y sondas',
    modules: [
      {
        key: 'discovery.passive',
        name: 'Discovery pasivo',
        icon: 'radar',
        capability: 'ARP, LLDP, CDP y ENTITY. Inventario sugerido persistente.',
        onByDefault: false,
      },
      {
        key: 'modules.discovery.active',
        name: 'Discovery activo',
        icon: 'travel_explore',
        capability: 'Requiere authorized: true. En 1.4 no barre la red.',
        onByDefault: false,
      },
      {
        key: 'probes',
        name: 'Sondas',
        icon: 'speed',
        capability: 'ICMP o TCP: latencia, pérdida y si el destino responde.',
        onByDefault: false,
      },
    ],
  },
];

@Component({
  selector: 'app-agent-page',
  imports: [MatIcon, EkuPageHeaderComponent, EkuErrorStateComponent],
  templateUrl: './agent-page.html',
  styleUrl: './agent-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentPage {
  private readonly http = inject(HttpClient);
  private readonly tenants = inject(TenantService);

  protected readonly releasesUrl = RELEASES_PAGE;
  protected readonly liveOn = signal<Record<string, boolean>>({});
  protected readonly groups = computed(() =>
    MODULE_GROUPS.map((group) => ({
      ...group,
      modules: group.modules.map((item) => ({
        ...item,
        on: this.moduleOn(item),
      })),
    })),
  );
  protected readonly release = signal<GithubRelease | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly catalogVersion = computed(() =>
    versionFromTag(this.release()?.tag_name ?? FALLBACK_VERSION),
  );
  protected readonly releaseLabel = computed(
    () =>
      `Ekumetrics Agent ${this.catalogVersion()} · linux/amd64`,
  );

  protected readonly cards = computed<InstallerCard[]>(() => {
    const version = this.catalogVersion();
    const assets = this.mergeAssets(version, this.release()?.assets ?? []);
    return [
      {
        id: 'deb',
        title: 'Debian / Ubuntu',
        os: 'Linux',
        hint: `.deb · amd64 · v${version}`,
        icon: 'terminal',
        badge: 'DEB',
        command: `sudo apt-get install -y ./ekumetrics-agent_${version}-1_amd64.deb`,
        asset: assets.find((item) => item.name.endsWith('.deb')) ?? null,
      },
      {
        id: 'rpm',
        title: 'Rocky / RHEL',
        os: 'Linux',
        hint: `.rpm · x86_64 · v${version}`,
        icon: 'dns',
        badge: 'RPM',
        command: `sudo dnf install -y ./ekumetrics-agent-${version}-1.x86_64.rpm`,
        asset: assets.find((item) => item.name.endsWith('.rpm')) ?? null,
      },
      {
        id: 'tgz',
        title: 'Linux genérico',
        os: 'Linux',
        hint: `.tar.gz · x86_64 · v${version}`,
        icon: 'folder_zip',
        badge: 'TGZ',
        command: `tar -xzf ekumetrics-agent-${version}-linux-amd64.tar.gz && sudo ./install.sh`,
        asset: assets.find((item) => item.name.endsWith('.tar.gz')) ?? null,
      },
    ];
  });

  constructor() {
    this.http.get<GithubRelease>(RELEASES_API).subscribe({
      next: (value) => {
        if (value.draft || value.prerelease || !versionFromTag(value.tag_name || '')) {
          this.release.set(this.fallbackRelease());
          return;
        }
        this.release.set(value);
        this.error.set(null);
      },
      error: () => {
        this.release.set(this.fallbackRelease());
      },
    });
    this.loadLiveModules();
  }

  private loadLiveModules(): void {
    const query = new URLSearchParams();
    const tenantId = this.tenants.slug();
    if (tenantId) {
      query.set('tenant_id', tenantId);
    }
    query.set('range', '1h');
    this.http
      .get<{ agent?: { modules?: Array<{ module: string; enabled: boolean }> } }>(
        `${API_BASE_URL}/v1/dashboard?${query.toString()}`,
      )
      .subscribe({
        next: (board) => {
          const live: Record<string, boolean> = {};
          for (const item of board.agent?.modules ?? []) {
            if (item.module) {
              live[item.module] = item.enabled;
            }
          }
          this.liveOn.set(live);
        },
      });
  }

  private moduleOn(item: AgentModule): boolean {
    const live = this.liveOn();
    if (Object.keys(live).length === 0) {
      return item.onByDefault;
    }
    return live[item.key] === true || live[this.reportedKey(item.key)] === true;
  }

  /** El YAML de 1.4 usa snmp.devices; la serie sigue siendo metrics.snmp. */
  private reportedKey(key: string): string {
    return key === 'snmp.devices' ? 'metrics.snmp' : key;
  }

  protected formatSize(bytes: number): string {
    if (!bytes) {
      return this.catalogVersion();
    }
    return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  }

  private fallbackRelease(): GithubRelease {
    return {
      tag_name: `v${FALLBACK_VERSION}`,
      name: `Ekumetrics Agent ${FALLBACK_VERSION}`,
      html_url: `${RELEASES_PAGE}/tag/v${FALLBACK_VERSION}`,
      assets: catalogAssets(FALLBACK_VERSION),
    };
  }

  private mergeAssets(version: string, remote: GithubAsset[]): GithubAsset[] {
    return catalogAssets(version).map((fallback) => {
      const found = remote.find((item) => item.name === fallback.name);
      return found ?? fallback;
    });
  }
}
