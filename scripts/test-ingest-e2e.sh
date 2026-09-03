#!/usr/bin/env bash
set -euo pipefail

network_name="ekumetrics-ingest-e2e-net"
db_name="ekumetrics-ingest-e2e-db"
api_name="ekumetrics-ingest-e2e-api"
gateway_name="ekumetrics-ingest-e2e-gateway"
otel_name="ekumetrics-ingest-e2e-otel"
prometheus_name="ekumetrics-ingest-e2e-prometheus"
api_image="${API_IMAGE:-ekumetrics-platform-api:1.0.0}"
gateway_template="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/infrastructure/docker/ingest-gateway/default.conf.template"
otel_config="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/infrastructure/docker/otel/e2e.yaml"
prometheus_config="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/infrastructure/docker/prometheus/e2e.yml"

cleanup() {
  docker stop "$gateway_name" "$api_name" "$prometheus_name" "$otel_name" "$db_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "$network_name" >/dev/null
docker run --rm -d --name "$db_name" --network "$network_name" \
  -e POSTGRES_USER=ekumetrics \
  -e POSTGRES_PASSWORD=validation \
  -e POSTGRES_DB=ekumetrics \
  postgres:18.6-alpine >/dev/null

for attempt in {1..30}; do
  if docker exec "$db_name" pg_isready -U ekumetrics -d ekumetrics >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    echo "PostgreSQL no quedó listo" >&2
    exit 1
  fi
  sleep 1
done

database_url="postgresql://ekumetrics:validation@${db_name}:5432/ekumetrics?schema=public"
docker run --rm -d --name "$otel_name" --network "$network_name" \
  --network-alias otel-collector \
  -v "$otel_config:/etc/otelcol-contrib/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:0.159.0 \
  --config=/etc/otelcol-contrib/config.yaml >/dev/null

docker run --rm -d --name "$prometheus_name" --network "$network_name" \
  --network-alias prometheus \
  -v "$prometheus_config:/etc/prometheus/prometheus.yml:ro" \
  prom/prometheus:v3.14.0 \
  --config.file=/etc/prometheus/prometheus.yml >/dev/null

docker run --rm -d --name "$api_name" --network "$network_name" \
  --network-alias platform-api \
  -e "DATABASE_URL=$database_url" \
  -e INGEST_SHARED_KEY=e2e-secret \
  -e PROMETHEUS_URL=http://prometheus:9090 \
  -e PORT=3000 \
  "$api_image" >/dev/null

for attempt in {1..30}; do
  if docker exec "$api_name" node -e \
    "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    docker logs "$api_name"
    exit 1
  fi
  sleep 1
done

docker exec "$db_name" psql -U ekumetrics -d ekumetrics -v ON_ERROR_STOP=1 -c \
  "INSERT INTO \"Tenant\" (id,slug,name,\"createdAt\",\"updatedAt\") VALUES ('tenant-e2e','cliente','Cliente E2E',now(),now());
   INSERT INTO \"Site\" (id,\"tenantId\",slug,name,\"createdAt\",\"updatedAt\") VALUES ('site-e2e','tenant-e2e','santiago','Santiago',now(),now());
   INSERT INTO \"Agent\" (id,\"tenantId\",\"agentId\",\"siteId\",mode,\"createdAt\",\"updatedAt\") VALUES ('agent-e2e','tenant-e2e','agent-01','santiago','site',now(),now());" >/dev/null

for attempt in {1..30}; do
  if docker exec "$api_name" node -e \
    "fetch('http://prometheus:9090/-/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    docker logs "$prometheus_name"
    exit 1
  fi
  sleep 1
done

docker run --rm -d --name "$gateway_name" --network "$network_name" \
  -v "$gateway_template:/etc/nginx/templates/default.conf.template:ro" \
  -e INGEST_SHARED_KEY=e2e-secret \
  nginx:1.30.4-alpine >/dev/null

for attempt in {1..30}; do
  if docker exec "$api_name" node -e \
    "fetch('http://${gateway_name}:4318/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    docker logs "$gateway_name"
    exit 1
  fi
  sleep 1
done

docker exec "$api_name" node -e "
const event = [{
  timestamp: '2026-08-26T12:00:00Z', tenant_id: 'cliente', site_id: 'santiago',
  agent_id: 'agent-01', asset_id: 'site/santiago/ip/10.0.0.1', asset_type: 'switch',
  signal: 'asset_discovered', value: 1, severity: 'info', source: 'discovery',
  tags: { ip: '10.0.0.1' }
}];
async function send() {
  const response = await fetch('http://${gateway_name}:4318/v1/ekms/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event)
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
(async () => {
  const first = await send();
  const second = await send();
  if (first.accepted !== 1 || first.duplicates !== 0 || second.accepted !== 0 || second.duplicates !== 1) {
    throw new Error(JSON.stringify({ first, second }));
  }
})().catch(error => { console.error(error); process.exit(1); });
"

docker exec "$api_name" node -e "
const now = String(BigInt(Date.now()) * 1000000n);
const body = {
  resourceMetrics: [{
    resource: { attributes: [
      { key: 'tenant.id', value: { stringValue: 'cliente' } },
      { key: 'host.site', value: { stringValue: 'santiago' } },
      { key: 'agent.id', value: { stringValue: 'agent-01' } }
    ] },
    scopeMetrics: [{ scope: { name: 'ekumetrics-agent-e2e' }, metrics: [{
      name: 'ekms_agent_identity',
      gauge: { dataPoints: [{ timeUnixNano: now, asDouble: 1 }] }
    }] }]
  }]
};
fetch('http://${gateway_name}:4318/v1/metrics', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
}).then(async response => {
  if (!response.ok) throw new Error(await response.text());
}).catch(error => { console.error(error); process.exit(1); });
"

metric_visible="false"
for attempt in {1..30}; do
  if docker exec "$api_name" node -e "
    const query = new URLSearchParams({ query: 'ekms_agent_identity{tenant_id=\"cliente\",site_id=\"santiago\",agent_id=\"agent-01\"}' });
    fetch('http://prometheus:9090/api/v1/query?' + query).then(r => r.json()).then(body => {
      const result = body?.data?.result ?? [];
      process.exit(result.length === 1 && Number(result[0].value?.[1]) === 1 ? 0 : 1);
    }).catch(() => process.exit(1));
  " >/dev/null 2>&1; then
    metric_visible="true"
    break
  fi
  sleep 1
done

if [[ "$metric_visible" != "true" ]]; then
  echo "La métrica E2E no apareció en Prometheus con su identidad completa" >&2
  docker logs "$otel_name"
  exit 1
fi

state="$(docker exec "$db_name" psql -U ekumetrics -d ekumetrics -At -c \
  'SELECT (SELECT count(*) FROM "AgentEvent") || '\''|'\'' || (SELECT count(*) FROM "Asset") || '\''|'\'' || (SELECT status FROM "Asset" LIMIT 1) || '\''|'\'' || (SELECT ("lastSeenAt" IS NOT NULL)::text FROM "Agent" LIMIT 1);')"
if [[ "$state" != "1|1|known|true" ]]; then
  echo "Estado E2E inesperado: $state" >&2
  exit 1
fi

echo "Ingesta E2E correcta: $state; métrica visible en Prometheus=true"
