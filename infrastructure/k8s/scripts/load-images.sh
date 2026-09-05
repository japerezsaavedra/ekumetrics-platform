#!/bin/sh
set -eu

VERSION="${EKUMETRICS_VERSION:-1.0.0}"
PLATFORM="${IMAGE_PLATFORM:-linux/amd64}"
WORKERS="${K8S_WORKERS:-wk-gd-1 wk-gd-2 wk-gd-3}"
BUILD="${1:-}"
root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)

if [ "$BUILD" = "--build" ] || [ "$BUILD" = "--build-amd64" ]; then
  echo "Construyendo platform-api y portal-web para $PLATFORM..."
  docker build --platform "$PLATFORM" --provenance=false \
    -t "ekumetrics/platform-api:${VERSION}" \
    -f "$root/apps/platform-api/Dockerfile" "$root"
  docker build --platform "$PLATFORM" --provenance=false \
    -t "ekumetrics/portal-web:${VERSION}" \
    -f "$root/apps/portal-web/Dockerfile" "$root"
else
  docker image inspect "ekumetrics/platform-api:${VERSION}" >/dev/null
  docker image inspect "ekumetrics/portal-web:${VERSION}" >/dev/null
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Empaquetando imágenes..."
docker save -o "$tmp/platform-api.tar" "ekumetrics/platform-api:${VERSION}"
docker save -o "$tmp/portal-web.tar" "ekumetrics/portal-web:${VERSION}"

import_host() {
  host=$1
  echo "Importando en $host..."
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$host" 'sudo -n k3s ctr -n k8s.io images import -' <"$tmp/platform-api.tar"
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$host" 'sudo -n k3s ctr -n k8s.io images import -' <"$tmp/portal-web.tar"
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$host" \
    "sudo -n k3s ctr -n k8s.io images label docker.io/ekumetrics/platform-api:${VERSION} io.cri-containerd.image=managed && \
     sudo -n k3s ctr -n k8s.io images label docker.io/ekumetrics/portal-web:${VERSION} io.cri-containerd.image=managed"
  echo "Listo $host."
}

for host in $WORKERS; do
  import_host "$host" &
done
wait

echo "Imágenes ekumetrics/platform-api:${VERSION} y ekumetrics/portal-web:${VERSION} en workers."
