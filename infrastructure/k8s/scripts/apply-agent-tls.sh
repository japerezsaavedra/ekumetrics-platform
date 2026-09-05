#!/bin/sh
set -eu

NS="${NS:-ekumetrics}"
HOST="${AGENT_PUBLIC_HOST:-ingest-ekumetrics.gd.lan}"

if kubectl -n "$NS" get secret ekumetrics-agent-tls >/dev/null 2>&1; then
  echo "El secreto ekumetrics-agent-tls ya existe en $NS. No se regenera."
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

openssl genrsa -out "$tmp/ca.key" 4096
openssl req -x509 -new -nodes -key "$tmp/ca.key" -sha256 -days 825 \
  -out "$tmp/ca.crt" -subj "/CN=ekumetrics-agent-ca"

openssl genrsa -out "$tmp/server.key" 2048
openssl req -new -key "$tmp/server.key" -out "$tmp/server.csr" \
  -subj "/CN=${HOST}"

cat >"$tmp/san.cnf" <<EOF
subjectAltName=DNS:${HOST},DNS:localhost,IP:127.0.0.1,IP:10.0.0.2,IP:10.0.0.3,IP:10.0.0.6
extendedKeyUsage=serverAuth
EOF

openssl x509 -req -in "$tmp/server.csr" -CA "$tmp/ca.crt" -CAkey "$tmp/ca.key" \
  -CAcreateserial -out "$tmp/server.crt" -days 825 -sha256 -extfile "$tmp/san.cnf"

kubectl -n "$NS" create secret generic ekumetrics-agent-tls \
  --from-file=ca.crt="$tmp/ca.crt" \
  --from-file=ca.key="$tmp/ca.key" \
  --from-file=server.crt="$tmp/server.crt" \
  --from-file=server.key="$tmp/server.key"

echo "Creada CA y certificado de servidor para ${HOST} (laboratorio, 825 días)."
