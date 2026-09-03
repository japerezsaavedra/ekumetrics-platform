#!/bin/sh
set -eu

envsubst '${PORTAL_API_URL} ${PORTAL_GRAFANA_URL}' \
  < /opt/ekumetrics/runtime-config.js.template \
  > /usr/share/nginx/html/runtime-config.js
