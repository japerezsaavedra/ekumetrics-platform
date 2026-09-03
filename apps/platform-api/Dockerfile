FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
ENV DATABASE_URL=postgresql://ekumetrics:ekumetrics@localhost:5432/ekumetrics?schema=public
RUN npm install --global npm@12.0.2
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY apps/platform-api/package.json apps/platform-api/package-lock.json ./
RUN npm ci
COPY apps/platform-api/ ./
RUN npx prisma generate && npm run build

FROM node:24.19.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY apps/platform-api/package.json apps/platform-api/package-lock.json ./
RUN npm install --global npm@12.0.2 \
  && npm ci --omit=dev \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/generated ./generated
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node --from=build /app/prisma.config.ts ./
COPY --chown=node:node apps/platform-api/docker-entrypoint.sh /entrypoint.sh
COPY --chown=node:node apps/platform-api/load-secrets.sh /load-secrets.sh
RUN chmod +x /entrypoint.sh /load-secrets.sh
USER node
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
