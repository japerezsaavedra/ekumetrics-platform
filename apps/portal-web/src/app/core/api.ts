function publicHost(): string {
  const hostname = globalThis.location?.hostname;
  return hostname && hostname.length > 0 ? hostname : 'localhost';
}

const host = publicHost();
const protocol = globalThis.location?.protocol === 'https:' ? 'https:' : 'http:';
const runtime = (
  globalThis as typeof globalThis & {
    __EKUMETRICS_CONFIG__?: {
      apiUrl?: string;
      grafanaUrl?: string;
    };
  }
).__EKUMETRICS_CONFIG__;

function endpoint(configured: string | undefined, fallbackPort: number): string {
  return configured?.replace(/\/$/, '') || `${protocol}//${host}:${fallbackPort}`;
}

export const API_BASE_URL = endpoint(runtime?.apiUrl, 3000);
export const GRAFANA_BASE_URL = endpoint(runtime?.grafanaUrl, 3001);
