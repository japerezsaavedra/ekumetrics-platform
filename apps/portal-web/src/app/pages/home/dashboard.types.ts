export type SeriesPoint = [number, number];

export type NamedSeries = {
  state: string;
  values: SeriesPoint[];
};

export type HostProcess = {
  name: string;
  pid: string;
  cpu: number | null;
  memoryBytes: number | null;
  virtualBytes: number | null;
  diskReadBytesPerSec: number;
  diskWriteBytesPerSec: number;
};

export type DiskMount = {
  mount: string;
  device: string;
  type: string;
  used: number;
  usedBytes: number;
  freeBytes: number;
  totalBytes: number;
};

export type DashboardHostOption = {
  id: string;
  siteId: string | null;
  tenantId: string | null;
  mode?: string | null;
  version?: string | null;
  online?: boolean | null;
  cpuUsed?: number | null;
  memoryUsed?: number | null;
  uptimeSeconds?: number | null;
  agentUptimeSeconds?: number | null;
  cpus?: number | null;
};

export type DashboardNic = {
  hostId: string;
  siteId: string | null;
  device: string;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  errorsPerSec: number;
  dropsPerSec: number;
};

export type DashboardDatabase = {
  hostId: string;
  siteId: string | null;
  engine: string;
  name: string;
  up: boolean;
};

export type IcewarpService = {
  name: string;
  running: boolean;
  uptimeSeconds: number | null;
  sessions: number | null;
  sessionsPeak: number | null;
  workingSetBytes: number | null;
};

export type IcewarpProbe = {
  name: string;
  endpoint: string;
  up: boolean;
  rttSeconds: number | null;
};

export type IcewarpBoard = {
  hostId: string | null;
  name: string;
  servicesUp: number;
  servicesTotal: number;
  sessions: number | null;
  smtpIn: number | null;
  smtpOut: number | null;
  smtpFailed: number | null;
  rejected: number | null;
  services: IcewarpService[];
  probes: IcewarpProbe[];
  series: {
    sessions: NamedSeries[];
    memory: NamedSeries[];
    smtp: NamedSeries[];
    defense: NamedSeries[];
    probesRtt: NamedSeries[];
  };
};

export type DashboardResponse = {
  hosts: DashboardHostOption[];
  nics?: DashboardNic[];
  databases?: DashboardDatabase[];
  networkDevices?: DashboardDatabase[];
  queues?: DashboardDatabase[];
  icewarp?: DashboardDatabase[];
  icewarpBoard?: IcewarpBoard | null;
  sap?: DashboardDatabase[];
  agents: Array<{ agentId: string; tenantId: string | null; siteId: string | null }>;
  agentId: string | null;
  thresholds?: {
    cpuWarn: number;
    cpuCrit: number;
    memWarn: number;
    memCrit: number;
    diskWarn: number;
    diskCrit: number;
  };
  refreshedAt: number;
  host: {
    id: string | null;
    siteId: string | null;
    tenantId: string | null;
    cpus: number | null;
    cpuUsed: number | null;
    memoryUsed: number | null;
    memoryUsedBytes: number | null;
    memoryTotalBytes: number | null;
    diskUsed: number | null;
    diskUsedBytes: number | null;
    diskTotalBytes: number | null;
    disks: DiskMount[];
    processes?: HostProcess[];
    load1m: number | null;
    load5m: number | null;
    load15m: number | null;
    uptimeSeconds: number | null;
    series: {
      cpu: SeriesPoint[];
      cpuByState: NamedSeries[];
      load1: SeriesPoint[];
      load5: SeriesPoint[];
      load15: SeriesPoint[];
      memoryByState: NamedSeries[];
      networkRx: SeriesPoint[];
      networkTx: SeriesPoint[];
      diskIo: NamedSeries[];
      diskOps: NamedSeries[];
      networkPackets: NamedSeries[];
      networkFaults: NamedSeries[];
      networkConn: NamedSeries[];
    };
  };
  agent: {
    online: boolean;
    lastSampleSeconds: number | null;
    uptimeSeconds?: number | null;
    licenseValid: boolean | null;
    licenseRemainingSeconds: number | null;
    version: string | null;
    identity: Record<string, string>;
    modules: Array<{ module: string; enabled: boolean }>;
    assetsKnown: number | null;
    assetsSuggested: number | null;
  };
  logs: {
    volume: SeriesPoint[];
    volumeAll: SeriesPoint[];
    lines: Array<{ ts: number; line: string; fields?: Record<string, string> }>;
  };
};
