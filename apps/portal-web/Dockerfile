FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
RUN npm install --global npm@12.0.2
COPY apps/portal-web/package.json apps/portal-web/package-lock.json ./
RUN npm ci
COPY apps/portal-web/ ./
RUN npm run build

FROM nginx:1.30.4-alpine
RUN apk upgrade --no-cache libcrypto3 libssl3
ENV NGINX_ENVSUBST_FILTER="^PORTAL_" \
    PORTAL_API_URL="http://localhost:3000" \
    PORTAL_GRAFANA_URL="http://localhost:3001"
COPY apps/portal-web/nginx.conf /etc/nginx/templates/default.conf.template
COPY apps/portal-web/runtime-config.js.template /opt/ekumetrics/runtime-config.js.template
COPY apps/portal-web/docker-runtime-config.sh /docker-entrypoint.d/40-ekumetrics-runtime-config.sh
COPY --from=build /app/dist/portal-web/browser /usr/share/nginx/html
# Archivos de marca exportados desde herramientas de diseño pueden conservar
# permisos 0600. Nginx sirve contenido como el usuario `nginx`, por lo que
# normalizamos lectura y acceso a directorios en la imagen final.
RUN chmod -R a+rX /usr/share/nginx/html \
  && chmod 0555 /docker-entrypoint.d/40-ekumetrics-runtime-config.sh \
  && chown nginx:nginx /usr/share/nginx/html/runtime-config.js
RUN sed -i -e '/^user /d' -e 's#^pid .*#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf \
  && chown -R nginx:nginx /var/cache/nginx /var/log/nginx /etc/nginx/conf.d
USER nginx
EXPOSE 8080
