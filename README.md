# Ekumetrics Platform

Plano de control de Ekumetrics: API NestJS, portal Angular y laboratorio local.
Compatible con el contrato actual de **Ekumetrics Agent** (`/v1/ekms/events` + OTLP).

El código vive en `apps/`. El laboratorio, en `infrastructure/docker`.

## Arranque (laboratorio)

```bash
cp apps/platform-api/.env.example apps/platform-api/.env
npm run lab:up
npm run db:generate
npm run db:migrate
npm run api:dev
npm run portal:dev
```

| Servicio | URL |
|---|---|
| Portal | http://localhost:4200 |
| API health | http://localhost:3000/health |
| Grafana | http://localhost:3001 (ekumetrics / ekumetrics) |
| Prometheus | http://localhost:9091 |
| OTLP (agente) | `localhost:4317` (gRPC) y `localhost:4318` (HTTP, `/v1/logs`) |
| PostgreSQL | `localhost:5432` |
| NATS | `localhost:4222` |
| Keycloak (opcional) | `npm run lab:up -- --profile iam` → http://localhost:8080 |

Prometheus usa el puerto **9091** en el host para no chocar con el inventario del agente (`:9090`).

## Agente

No hace falta cambiar `agent-sap`. En laboratorio:

```yaml
export:
  otlp:
    endpoint: "localhost:4317"
    insecure: true
```

Los eventos irán a `http://localhost:4318/v1/ekms/events`. Esa ruta se implementa en la Fase 1.

## Decisiones

Ver `docs/adr/0001-stack-y-contrato-agente.md`.
