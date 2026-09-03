import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { startWith } from 'rxjs';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';

const FALLBACK_VERSION = '1.4.4';
const RELEASES_REPO = 'japerezsaavedra/ekumetrics-agent-releases';
const RELEASES_API = `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=12`;
const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases`;

type GithubAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

function versionFromTag(tag: string): string {
  return tag.trim().replace(/^v/i, '');
}

function catalogAsset(version: string, name: string): GithubAsset {
  return {
    name,
    browser_download_url: `https://github.com/${RELEASES_REPO}/releases/download/v${version}/${name}`,
    size: 0,
  };
}

function catalogAssets(version: string): GithubAsset[] {
  return [
    catalogAsset(version, `ekumetrics-agent_${version}-1_amd64.deb`),
    catalogAsset(version, `ekumetrics-agent-${version}-1.x86_64.rpm`),
    catalogAsset(version, `ekumetrics-agent-${version}-linux-amd64.tar.gz`),
    catalogAsset(version, 'ekumetrics-agent-linux-amd64'),
    catalogAsset(version, `ekumetrics-agent-${version}-windows-amd64.msi`),
    catalogAsset(version, `ekumetrics-agent-${version}-windows-amd64.zip`),
  ];
}

function pickAsset(assets: GithubAsset[], test: (name: string) => boolean): GithubAsset | null {
  return assets.find((item) => test(item.name)) ?? null;
}

type GithubRelease = {
  tag_name: string;
  name: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: GithubAsset[];
};

type OsId = 'linux' | 'windows';
type DistroId = 'deb' | 'rpm' | 'tgz' | 'bin' | 'msi' | 'zip';

type DistroOption = {
  id: DistroId;
  os: OsId;
  title: string;
  hint: string;
  install: (version: string) => string;
  verify: string;
  match: (name: string) => boolean;
};

const DISTROS: DistroOption[] = [
  {
    id: 'deb',
    os: 'linux',
    title: 'Debian / Ubuntu',
    hint: 'Paquete .deb · amd64',
    install: (version) =>
      `sudo apt-get install -y ./ekumetrics-agent_${version}-1_amd64.deb`,
    verify: 'sudo systemctl status ekumetrics-agent\ncurl -s http://127.0.0.1:9090/healthz',
    match: (name) => name.endsWith('.deb'),
  },
  {
    id: 'rpm',
    os: 'linux',
    title: 'Rocky / AlmaLinux / RHEL',
    hint: 'Paquete .rpm · x86_64',
    install: (version) => `sudo dnf install -y ./ekumetrics-agent-${version}-1.x86_64.rpm`,
    verify: 'sudo systemctl status ekumetrics-agent\ncurl -s http://127.0.0.1:9090/healthz',
    match: (name) => name.endsWith('.rpm'),
  },
  {
    id: 'tgz',
    os: 'linux',
    title: 'Cualquier Linux',
    hint: 'Archivo .tar.gz · x86_64',
    install: (version) =>
      `tar -xzf ekumetrics-agent-${version}-linux-amd64.tar.gz\ncd ekumetrics-agent-${version}-linux-amd64\nsudo ./install.sh`,
    verify: 'sudo systemctl status ekumetrics-agent\ncurl -s http://127.0.0.1:9090/healthz',
    match: (name) => name.endsWith('.tar.gz'),
  },
  {
    id: 'bin',
    os: 'linux',
    title: 'Binario',
    hint: 'ekumetrics-agent-linux-amd64',
    install: () =>
      `chmod +x ekumetrics-agent-linux-amd64\nsudo ./ekumetrics-agent-linux-amd64 --config /etc/ekumetrics-agent/agent.yaml`,
    verify: 'curl -s http://127.0.0.1:9090/healthz',
    match: (name) => name === 'ekumetrics-agent-linux-amd64',
  },
  {
    id: 'msi',
    os: 'windows',
    title: 'Windows Server (MSI)',
    hint: 'Instalador .msi · amd64',
    install: (version) => `msiexec /i ekumetrics-agent-${version}-windows-amd64.msi`,
    verify:
      'Get-Service ekumetrics-agent\nInvoke-WebRequest http://127.0.0.1:9090/healthz',
    match: (name) => name.endsWith('.msi'),
  },
  {
    id: 'zip',
    os: 'windows',
    title: 'Windows (zip)',
    hint: 'zip + install.ps1 · amd64',
    install: (version) =>
      `Expand-Archive .\\ekumetrics-agent-${version}-windows-amd64.zip\n.\\install.ps1`,
    verify:
      'Get-Service ekumetrics-agent\nInvoke-WebRequest http://127.0.0.1:9090/healthz',
    match: (name) => name.includes('windows') && name.endsWith('.zip'),
  },
];

@Component({
  selector: 'app-agent-page',
  imports: [MatIcon, ReactiveFormsModule, EkuPageHeaderComponent, EkuErrorStateComponent],
  templateUrl: './agent-page.html',
  styleUrl: './agent-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);

  protected readonly releasesUrl = RELEASES_PAGE;
  protected readonly releases = signal<GithubRelease[]>([this.fallbackRelease()]);
  protected readonly error = signal<string | null>(null);
  protected readonly picker = this.fb.nonNullable.group({
    version: [FALLBACK_VERSION, Validators.required],
    os: ['linux' as OsId, Validators.required],
    distro: ['deb' as DistroId, Validators.required],
  });
  private readonly pickerValue = toSignal(
    this.picker.valueChanges.pipe(startWith(this.picker.getRawValue())),
    { initialValue: this.picker.getRawValue() },
  );
  protected readonly versions = computed(() =>
    this.releases().map((item) => versionFromTag(item.tag_name)),
  );
  protected readonly distros = computed(() =>
    DISTROS.filter((item) => item.os === this.pickerValue().os),
  );
  protected readonly releaseLabel = computed(
    () => `Ekumetrics Agent ${this.versions()[0] ?? FALLBACK_VERSION} · linux/amd64 · windows/amd64`,
  );
  protected readonly selected = computed(() => {
    const picked = this.pickerValue();
    const version = picked.version ?? FALLBACK_VERSION;
    const distro = picked.distro ?? 'deb';
    const option = DISTROS.find((item) => item.id === distro) ?? DISTROS[0];
    const release =
      this.releases().find((item) => versionFromTag(item.tag_name) === version) ??
      this.releases()[0];
    const assets = this.mergeAssets(version, release?.assets ?? []);
    return {
      ...option,
      version,
      install: option.install(version),
      asset: pickAsset(assets, option.match),
    };
  });

  constructor() {
    this.picker.controls.os.valueChanges.subscribe((os) => {
      const first = DISTROS.find((item) => item.os === os);
      if (first && !DISTROS.some((item) => item.id === this.picker.controls.distro.value && item.os === os)) {
        this.picker.controls.distro.setValue(first.id);
      }
    });
    this.http.get<GithubRelease[]>(RELEASES_API).subscribe({
      next: (items) => {
        const published = items.filter(
          (item) => !item.draft && !item.prerelease && versionFromTag(item.tag_name || ''),
        );
        this.releases.set(published.length ? published : [this.fallbackRelease()]);
        this.picker.controls.version.setValue(this.versions()[0] ?? FALLBACK_VERSION);
        this.error.set(null);
      },
      error: () => {
        this.releases.set([this.fallbackRelease()]);
      },
    });
  }

  protected formatSize(bytes: number): string {
    if (!bytes) {
      return this.selected().version;
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
      return found
        ? { ...found, browser_download_url: fallback.browser_download_url }
        : fallback;
    });
  }
}
