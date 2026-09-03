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

load_secret KC_DB_PASSWORD
load_secret KC_BOOTSTRAP_ADMIN_PASSWORD
exec /opt/keycloak/bin/kc.sh "$@"
