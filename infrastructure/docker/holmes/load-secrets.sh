#!/bin/sh
set -eu

[ -n "${OPENAI_API_KEY_FILE:-}" ] || { echo 'Falta OPENAI_API_KEY_FILE.' >&2; exit 1; }
[ -r "$OPENAI_API_KEY_FILE" ] || { echo 'No se puede leer OPENAI_API_KEY_FILE.' >&2; exit 1; }
OPENAI_API_KEY=$(cat "$OPENAI_API_KEY_FILE")
[ -n "$OPENAI_API_KEY" ] || { echo 'OPENAI_API_KEY_FILE está vacío.' >&2; exit 1; }
export OPENAI_API_KEY
unset OPENAI_API_KEY_FILE
exec python -u server.py
