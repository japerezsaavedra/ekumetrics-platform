#!/bin/sh
set -eu

load_secret() {
  name="$1"
  eval "file=\${${name}_FILE:-}"
  [ -n "$file" ] || return 0
  [ -r "$file" ] || { echo "No se puede leer el secreto $name." >&2; exit 1; }
  value=$(cat "$file")
  [ -n "$value" ] || { echo "El secreto $name está vacío." >&2; exit 1; }
  export "$name=$value"
  unset "${name}_FILE"
}

for secret_name in \
  DATABASE_URL \
  KEYCLOAK_ADMIN_PASSWORD \
  INGEST_SHARED_KEY \
  AGENT_EDGE_ASSERTION_KEY \
  KIOSK_TOKEN_SECRET \
  BFF_SESSION_SECRET \
  AI_SETTINGS_ENCRYPTION_KEY \
  HOLMES_UPSTREAM_KEY \
  OPENAI_API_KEY \
  ANTHROPIC_API_KEY \
  MOONSHOT_API_KEY \
  XAI_API_KEY \
  DEEPSEEK_API_KEY \
  AI_COMPAT_API_KEY
do
  load_secret "$secret_name"
done
