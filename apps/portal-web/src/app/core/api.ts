function publicHost(): string {
  const hostname = globalThis.location?.hostname;
  return hostname && hostname.length > 0 ? hostname : 'localhost';
}

const host = publicHost();

export const API_BASE_URL = `http://${host}:3000`;
export const GRAFANA_BASE_URL = `http://${host}:3001`;
export const KEYCLOAK_URL = `http://${host}:8080`;
export const KEYCLOAK_REALM = 'ekumetrics';
export const KEYCLOAK_CLIENT_ID = 'portal-web';
