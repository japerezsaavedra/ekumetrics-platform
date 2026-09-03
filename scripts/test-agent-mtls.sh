#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
work_dir=$(mktemp -d)
container_name="ekumetrics-agent-mtls-test-$$"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT INT TERM

mkdir -p "$work_dir/tls" "$work_dir/secrets"
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -subj '/CN=Ekumetrics Test Agent CA' \
  -keyout "$work_dir/ca.key" -out "$work_dir/tls/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -subj '/CN=localhost' \
  -keyout "$work_dir/tls/server.key" -out "$work_dir/server.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:localhost' 'extendedKeyUsage=serverAuth' > "$work_dir/server.ext"
openssl x509 -req -days 45 -sha256 \
  -in "$work_dir/server.csr" -CA "$work_dir/tls/ca.crt" -CAkey "$work_dir/ca.key" -CAcreateserial \
  -extfile "$work_dir/server.ext" -out "$work_dir/tls/server.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -subj '/O=cliente/OU=santiago/CN=agent-01' \
  -keyout "$work_dir/client.key" -out "$work_dir/client.csr" >/dev/null 2>&1
printf '%s\n' 'extendedKeyUsage=clientAuth' > "$work_dir/client.ext"
openssl x509 -req -days 2 -sha256 \
  -in "$work_dir/client.csr" -CA "$work_dir/tls/ca.crt" -CAkey "$work_dir/ca.key" -CAcreateserial \
  -extfile "$work_dir/client.ext" -out "$work_dir/client.crt" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/O=cliente/OU=santiago/CN=agent-01' \
  -keyout "$work_dir/untrusted-client.key" -out "$work_dir/untrusted-client.crt" >/dev/null 2>&1
printf '%s' '0123456789abcdef0123456789abcdef' > "$work_dir/secrets/ingest"
printf '%s' 'abcdef0123456789abcdef0123456789' > "$work_dir/secrets/assertion"

node --input-type=module -e '
  const module = await import(`file://${process.argv[1]}/scripts/preflight.mjs`);
  const errors = module.validateTlsDirectory(process.argv[2], "localhost");
  if (errors.length) throw new Error(errors.join("\n"));
' "$repo_dir" "$work_dir/tls"

docker run -d --name "$container_name" \
  --add-host platform-api:127.0.0.1 \
  --add-host otel-collector:127.0.0.1 \
  -p 127.0.0.1::4318 \
  -e INGEST_SHARED_KEY_FILE=/run/secrets/ingest \
  -e AGENT_EDGE_ASSERTION_KEY_FILE=/run/secrets/assertion \
  -v "$repo_dir/infrastructure/docker/agent-edge/15-load-secrets.envsh:/docker-entrypoint.d/15-load-secrets.envsh:ro" \
  -v "$repo_dir/infrastructure/docker/agent-edge/default.conf.template:/etc/nginx/templates/default.conf.template:ro" \
  -v "$work_dir/tls:/run/agent-tls:ro" \
  -v "$work_dir/secrets/ingest:/run/secrets/ingest:ro" \
  -v "$work_dir/secrets/assertion:/run/secrets/assertion:ro" \
  nginx:1.30.4-alpine >/dev/null

host_port=$(docker port "$container_name" 4318/tcp | sed 's/.*://')
sleep 1
if [ "$(docker inspect --format '{{.State.Running}}' "$container_name")" != 'true' ]; then
  docker logs "$container_name" >&2
  exit 1
fi
attempt=0
until [ "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --resolve "localhost:${host_port}:127.0.0.1" \
  --cacert "$work_dir/tls/ca.crt" --cert "$work_dir/client.crt" --key "$work_dir/client.key" \
  "https://localhost:${host_port}/not-found" 2>/dev/null || true)" = '404' ] || [ "$attempt" -ge 20 ]; do
  attempt=$((attempt + 1))
  sleep 1
done

if [ "$attempt" -ge 20 ]; then
  docker logs "$container_name" >&2
  echo 'El borde mTLS no quedó listo dentro del plazo.' >&2
  exit 1
fi

status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --resolve "localhost:${host_port}:127.0.0.1" \
  --cacert "$work_dir/tls/ca.crt" --cert "$work_dir/client.crt" --key "$work_dir/client.key" \
  "https://localhost:${host_port}/not-found")
[ "$status" = '404' ] || { echo "El borde mTLS no respondió como se esperaba ($status)." >&2; exit 1; }

if curl --silent --fail --cacert "$work_dir/tls/ca.crt" \
  --resolve "localhost:${host_port}:127.0.0.1" \
  "https://localhost:${host_port}/not-found" >/dev/null 2>&1; then
  echo 'El borde aceptó una conexión sin certificado cliente.' >&2
  exit 1
fi

if curl --silent --fail --cacert "$work_dir/tls/ca.crt" \
  --resolve "localhost:${host_port}:127.0.0.1" \
  --cert "$work_dir/untrusted-client.crt" --key "$work_dir/untrusted-client.key" \
  "https://localhost:${host_port}/not-found" >/dev/null 2>&1; then
  echo 'El borde aceptó un certificado cliente emitido por una CA no confiable.' >&2
  exit 1
fi

echo '✓ Borde del agente acepta la CA configurada y rechaza clientes ausentes o no confiables.'
