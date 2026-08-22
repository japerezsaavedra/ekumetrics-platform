FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY apps/portal-web/package.json apps/portal-web/package-lock.json ./
RUN npm ci
COPY apps/portal-web/ ./
RUN npm run build

FROM nginx:1.28-alpine
COPY apps/portal-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/portal-web/browser /usr/share/nginx/html
EXPOSE 80
