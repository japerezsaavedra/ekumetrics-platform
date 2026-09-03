#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  echo "El Portal no debe ejecutar como root." >&2
  exit 1
fi

envsubst '${PORTAL_API_URL} ${PORTAL_GRAFANA_URL}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf
/docker-entrypoint.d/40-ekumetrics-runtime-config.sh

nginx -g "daemon off;" &
nginx_pid=$!
trap 'kill "$nginx_pid" 2>/dev/null || true' EXIT INT TERM

attempt=0
while [ "$attempt" -lt 10 ]; do
  if wget -qO- http://127.0.0.1:8080/healthz | grep -qx ok; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[ "$attempt" -lt 10 ] || { echo "El Portal no alcanzó healthz." >&2; exit 1; }

headers=$(wget -S -O /dev/null http://127.0.0.1:8080/ 2>&1)
printf '%s\n' "$headers" | grep -Fqi "Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none'"
printf '%s\n' "$headers" | grep -Fqi 'X-Frame-Options: DENY'
printf '%s\n' "$headers" | grep -Fqi 'X-Content-Type-Options: nosniff'
printf '%s\n' "$headers" | grep -Fqi 'Referrer-Policy: no-referrer'
printf '%s\n' "$headers" | grep -Fqi 'Permissions-Policy: camera=()'
printf '%s\n' "$headers" | grep -Fqi 'Cross-Origin-Opener-Policy: same-origin'
printf '%s\n' "$headers" | grep -Fqi 'Cross-Origin-Embedder-Policy: require-corp'
printf '%s\n' "$headers" | grep -Fqi 'Cross-Origin-Resource-Policy: same-origin'
printf '%s\n' "$headers" | grep -Fqi 'Cache-Control: no-store'
if printf '%s\n' "$headers" | grep -Eq 'Server: nginx/[0-9]'; then
  echo "El Portal expone la versión de Nginx." >&2
  exit 1
fi

runtime=$(wget -qO- http://127.0.0.1:8080/runtime-config.js)
printf '%s\n' "$runtime" | grep -Fq "apiUrl: 'http://localhost:3000'"
if printf '%s\n' "$runtime" | grep -Fq 'keycloakUrl'; then
  echo "El Portal no debe conocer el endpoint de Keycloak." >&2
  exit 1
fi

echo "✓ Portal no-root, healthcheck y cabeceras defensivas verificados."
