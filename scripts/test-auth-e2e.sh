#!/usr/bin/env bash
set -euo pipefail

container_name="ekumetrics-auth-e2e-keycloak"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
realm_file="$project_root/infrastructure/docker/keycloak/ekumetrics-realm.json"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker run -d --name "$container_name" \
  -p 127.0.0.1:18080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=auth-e2e-only \
  -e KC_HTTP_ENABLED=true \
  -e KC_HOSTNAME_STRICT=false \
  -e KC_HOSTNAME=http://127.0.0.1:18080 \
  -v "$realm_file:/opt/keycloak/data/import/ekumetrics-realm.json:ro" \
  quay.io/keycloak/keycloak:26.7.2 start-dev --import-realm >/dev/null

for attempt in {1..60}; do
  if node -e \
    "fetch('http://127.0.0.1:18080/realms/ekumetrics/.well-known/openid-configuration').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 60 ]]; then
    docker logs "$container_name"
    exit 1
  fi
  sleep 1
done

node "$project_root/scripts/auth-code-smoke.mjs"
