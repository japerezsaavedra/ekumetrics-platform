# Ekumetrics Platform

Versión **1.0.0**. Plano de control de Ekumetrics: API NestJS, portal Angular y laboratorio local.
Compatible con **Ekumetrics Agent 1.4** (`/v1/ekms/events` + OTLP).

El código vive en `apps/`. El laboratorio, en `infrastructure/docker`.

## Arranque (laboratorio)

Toda la plataforma, incluida API y portal:

```bash
npm run lab:up
```

La primera vez construye las imágenes. Para desarrollar API y portal en el host: `npm run lab:infra`, luego `api:dev` y `portal:dev`.

| Servicio | URL |
|---|---|
| Portal | http://localhost:4200 — login en `/login` |
| API | http://localhost:3000/health |
| Keycloak | http://localhost:8080 |
| Grafana | http://localhost:3001 (ekumetrics / ekumetrics) |
| Prometheus | http://localhost:9091 |
| OTLP (agente) | `localhost:4317` (gRPC) y `localhost:4318` (HTTP, `/v1/logs`) |
| PostgreSQL | `localhost:5432` |
| NATS | `localhost:4222` |
| EkuAssistant AI | http://localhost:4200/asistente (`npm run lab:ai`) |

Prometheus usa el puerto **9091** en el host para no chocar con el inventario del agente (`:9090`).

En `srv-apps` (`10.10.0.2`) se usa `infrastructure/docker/.env` con `BIND_ADDR=10.10.0.2` y `PUBLIC_HOST=10.10.0.2`. El portal queda en http://10.10.0.2:4200.

## Agente

No hace falta cambiar `ekumetrics-agent`. En laboratorio:

```yaml
export:
  otlp:
    endpoint: "localhost:4317"
    insecure: true
```

Los eventos irán a `http://localhost:4318/v1/ekms/events`. Esa ruta se implementa en la Fase 1.

## Login (laboratorio)

Keycloak ya arranca con `npm run lab:up`. Abra http://localhost:4200/login. Usuarios del realm `ekumetrics`:

| Usuario | Correo | Clave | Rol |
|---|---|---|---|
| operator | operator@gradotech.com | ekumetrics | operador (ve todos los tenants) |
| admin | admin@gradotech.com | ekumetrics | admin del tenant `default` |

Consola de Keycloak: http://localhost:8080 (`admin` / `ekumetrics`).

## EkuAssistant AI

El chat de `/asistente` usa el modelo elegido en `/configuracion`. Ollama corre en el mismo compose (`qwen3.5:4b`). El portal muestra el modelo en uso y si está activo, también para Grok, OpenAI o Claude.

`npm run lab:ai` sigue siendo opcional (Holmes).

## Tenants, sitios y agentes

Ver `docs/tenants-sitios-agentes.md`. Tipos comerciales: **Servidor**, **NOC**, **Sensor**, **Endpoint**.

## Decisiones

Ver `docs/adr/0001-stack-y-contrato-agente.md` y `docs/adr/0002-design-system.md`.
