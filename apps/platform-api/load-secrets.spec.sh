#!/bin/sh
set -eu

secret_dir=$(mktemp -d)
trap 'rm -rf "$secret_dir"' EXIT
printf '%s' '0123456789abcdef0123456789abcdef' > "$secret_dir/bff"
BFF_SESSION_SECRET_FILE="$secret_dir/bff"
export BFF_SESSION_SECRET_FILE
. "$(dirname "$0")/load-secrets.sh"
[ "$BFF_SESSION_SECRET" = '0123456789abcdef0123456789abcdef' ]
[ -z "${BFF_SESSION_SECRET_FILE:-}" ]

if DATABASE_URL_FILE="$secret_dir/missing" sh -c '. "$1/load-secrets.sh"' sh "$(dirname "$0")" 2>/dev/null; then
  echo 'El loader aceptó un secreto inexistente.' >&2
  exit 1
fi

echo '✓ Secretos montados cargados sin exponer su contenido.'
