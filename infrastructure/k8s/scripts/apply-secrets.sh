#!/bin/sh
set -eu

NS="${NS:-ekumetrics}"

rand() {
  openssl rand -base64 48 | tr -d '\n=/' | cut -c1-48
}

if kubectl -n "$NS" get secret ekumetrics-secrets >/dev/null 2>&1; then
  echo "El secreto ekumetrics-secrets ya existe en $NS. No se regenera."
  if ! kubectl -n "$NS" get secret ekumetrics-secrets -o jsonpath='{.data.grafana_admin_password}' | grep -q .; then
    grafana_admin_password=$(rand)
    encoded=$(printf '%s' "$grafana_admin_password" | base64 | tr -d '\n')
    kubectl -n "$NS" patch secret ekumetrics-secrets --type=json \
      -p "[{\"op\":\"add\",\"path\":\"/data/grafana_admin_password\",\"value\":\"${encoded}\"}]"
    echo "Añadida clave grafana_admin_password al secreto existente."
  fi
  exit 0
fi

postgres_password=$(rand)
keycloak_db_password=$(rand)
keycloak_admin_password=$(rand)
ingest_shared_key=$(rand)
agent_edge_assertion_key=$(rand)
kiosk_token_secret=$(rand)
bff_session_secret=$(rand)
ai_settings_encryption_key=$(rand)
holmes_upstream_key=$(rand)
database_url="postgresql://ekumetrics:${postgres_password}@postgres:5432/ekumetrics?schema=public"

kubectl -n "$NS" create secret generic ekumetrics-secrets \
  --from-literal=postgres_password="$postgres_password" \
  --from-literal=keycloak_db_password="$keycloak_db_password" \
  --from-literal=keycloak_admin_password="$keycloak_admin_password" \
  --from-literal=ingest_shared_key="$ingest_shared_key" \
  --from-literal=agent_edge_assertion_key="$agent_edge_assertion_key" \
  --from-literal=kiosk_token_secret="$kiosk_token_secret" \
  --from-literal=bff_session_secret="$bff_session_secret" \
  --from-literal=ai_settings_encryption_key="$ai_settings_encryption_key" \
  --from-literal=holmes_upstream_key="$holmes_upstream_key" \
  --from-literal=grafana_admin_password="$(rand)" \
  --from-literal=database_url="$database_url"

echo "Secreto ekumetrics-secrets creado en $NS."
echo "Admin de Keycloak (master): usuario admin. La contraseña está en el Secret, no se imprime."
