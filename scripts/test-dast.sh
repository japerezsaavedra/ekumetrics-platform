#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target_name="ekumetrics-dast-target"
network_name="ekumetrics-dast-network"
report_dir="${DAST_REPORT_DIR:-$project_root/artifacts/dast}"
zap_image="ghcr.io/zaproxy/zaproxy:2.17.0@sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef"

cleanup() {
  docker rm -f "$target_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

install -d -m 0777 "$report_dir"
docker build -f "$project_root/apps/portal-web/Dockerfile" -t ekumetrics-portal-web:dast "$project_root"
docker network create "$network_name" >/dev/null
docker run -d --name "$target_name" --network "$network_name" \
  -e PORTAL_API_URL=https://api.example.test \
  -e PORTAL_GRAFANA_URL=https://grafana.example.test \
  ekumetrics-portal-web:dast >/dev/null

for attempt in {1..30}; do
  if docker exec "$target_name" wget -qO- http://127.0.0.1:8080/healthz 2>/dev/null | grep -qx ok; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    docker logs "$target_name"
    exit 1
  fi
  sleep 1
done

docker run --rm --network "$network_name" \
  -v "$report_dir:/zap/wrk:rw" \
  "$zap_image" zap-baseline.py \
  -t "http://$target_name:8080" -m 1 -I \
  -J report.json -w report.md -r report.html

node "$project_root/scripts/zap-report-check.mjs" \
  "$report_dir/report.json" \
  "$project_root/security/dast/accepted-alerts.json"
