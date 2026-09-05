# Wave 1 — Application Event Bus

**Estado:** implementado (puerto + adaptador; sin puente de dominio).  
**Fecha:** 2026-09-04  
**Código:** `ekumetrics-platform/apps/platform-api/src/messaging/`

Nomenclatura: **Ekumetrics Agent** = recolector. **EventBus** = puerto de mensajería de plataforma. Un AIOps Agent (Rca, Metrics, …) es un investigador lógico y **no** vive en este módulo.

---

## Qué hay

| Pieza | Rol |
|---|---|
| `EventBus` | Puerto: `publish` / `subscribe` / `request` / `close` |
| `NatsJetStreamEventBus` | Único archivo que importa `@nats-io/transport-node` + `@nats-io/jetstream` (el paquete `nats` v2 está deprecado) |
| `InMemoryEventBus` | Tests y `EVENT_BUS_DRIVER=memory` |
| `DegradedEventBus` | NATS caído o sin `NATS_URL`; la API arranca igual |
| `EventSubjects` | Único sitio con strings de subjects |

El dominio (correlación, grafo, ingest) **no** se cableó en esta oleada. No importa el cliente NATS.

NATS JetStream reutilizado: servicio `nats` ya desplegado (Compose + k8s). No hay un segundo Deployment.

---

## Subjects (catálogo)

Definidos solo en `subjects.ts`:

| Constante | Subject |
|---|---|
| `EVENTS_INGESTED` | `ekumetrics.events.ingested` |
| `EVENTS_CORRELATED` | `ekumetrics.events.correlated` |
| `TOPOLOGY_UPDATED` | `ekumetrics.topology.updated` |
| `INCIDENTS_CREATED` | `ekumetrics.incidents.created` |
| `INCIDENTS_UPDATED` | `ekumetrics.incidents.updated` |
| `INCIDENTS_RESOLVED` | `ekumetrics.incidents.resolved` |
| `RCA_REQUESTED` | `ekumetrics.rca.requested` |
| `RCA_COMPLETED` | `ekumetrics.rca.completed` |
| `AIOPS_INVESTIGATION_REQUESTED` | `ekumetrics.aiops.investigation.requested` |
| `AIOPS_INVESTIGATION_COMPLETED` | `ekumetrics.aiops.investigation.completed` |

DLQ: `ekumetrics.dlq.<subject-original>` (`toDeadLetterSubject`).

Streams JetStream (creados al conectar): `EKU_EVENTS`, `EKU_TOPOLOGY`, `EKU_INCIDENTS`, `EKU_RCA`, `EKU_AIOPS`, `EKU_DLQ`.

---

## Semántica

- **Durable consumers** (`consumerName` estable, `[A-Za-z0-9_-]+`).
- **Ack explícito** (`ctrl.ack` / `nak` / `term`). Si el handler retorna sin liquidar, se hace `nak`.
- **Retry + exponential backoff** (`backoffMs`, default 1s, 2s, 4s, 8s, 16s; `maxDeliveries` default 5).
- **Dead-letter** tras `maxDeliveries` o `term(reason)`.
- **Request/reply** (`EventBus.request`): in-memory vía `ctrl.respond`; NATS usa request-reply del core (no JetStream).
- **OpenTelemetry:** spans `messaging.publish`, `messaging.consume`, `messaging.request` (`ekumetrics.messaging`).
- **Logs** JSON en una línea, sin iconos (`event_bus.publish.ok`, `event_bus.dead_letter`, …).
- **Graceful shutdown:** `close()` detiene pulls y hace `drain` de la conexión; `SIGTERM`/`SIGINT` cierran el bus.

---

## Idempotencia (estrategia)

Dos capas. **No se tocó `AgentEvent` ni Prisma.**

1. **Broker:** `Nats-Msg-Id` = `idempotencyKey`. Un publish duplicado dentro de `duplicate_window` (2 min) no crea un segundo mensaje (`PublishResult.duplicate`).
2. **Aplicación:** `InMemoryIdempotencyStore` por `(consumerName, idempotencyKey)`, TTL 24 h, tope 10 000 entradas. Si la clave ya se procesó, el wrapper hace `ack` y no vuelve a ejecutar el handler.

El store es **por proceso**. Con varias réplicas de platform-api, dos pods pueden aplicar el mismo mensaje una vez cada uno hasta que exista una tabla dedicada (`MessageDedupe` o similar), **sin** reutilizar `AgentEvent`. Formato recomendado de clave: `{tenantId}:{subject}:{claveNatural}`.

---

## Degradación y health

Si `NATS_URL` falta o el connect inicial falla, se usa `DegradedEventBus`:

- Login, dashboard y el resto de HTTP **siguen**.
- `publish` / `request` lanzan `EventBusUnavailableError`.
- `subscribe` es no-op.

`/health` (liveness) no depende del bus.  
`/health/ready` exige PostgreSQL; el check `eventBus` es **informativo** (`ok` | `degraded`) y **no** tumba readiness. Así Kubernetes no saca el pod del servicio si NATS cae.

Tras un NATS caído **en el arranque**, hace falta reiniciar la API para volver a JetStream. Si el connect inicial tuvo éxito, el cliente reconecta solo.

Variables:

```text
NATS_URL=nats://nats:4222
NATS_TOKEN=                    # opcional; hoy el server no exige auth
EVENT_BUS_DRIVER=nats          # memory | nats
EVENT_BUS_CONNECT_TIMEOUT_MS=5000
```

En `NODE_ENV=test` el default es `memory` (e2e de login no habla con NATS).

`NATS_URL` se añadió al Compose (`platform-api`) y al ConfigMap `platform-config` de k8s, apuntando al NATS ya desplegado.

---

## Cómo probar

### Unitarios (sin NATS)

Desde `ekumetrics-platform/apps/platform-api`:

```bash
npm test -- event-bus.spec event-bus.retry.spec event-bus.idempotency.spec nats-jetstream.integration
```

El spec de integración se **salta** salvo `EVENT_BUS_INTEGRATION=1`. `streamForSubject` sí corre siempre.

Cubre: publish/subscribe/request, retry + DLQ, duplicado de productor, wrapper de consumer idempotente.

### Integración NATS

1. Levantar el NATS existente (no crear otro):

```bash
# desde ekumetrics-platform
npm run platform:services
# o solo: docker compose -f infrastructure/docker/docker-compose.yml up -d nats
```

2. Correr:

```bash
cd apps/platform-api
NATS_URL=nats://127.0.0.1:4222 EVENT_BUS_INTEGRATION=1 \
  npm test -- nats-jetstream.integration --runInBand
```

Valida connect, streams, publish, consumer durable, ack y `Msg-Id` duplicado.

### Arranque degradado

Sin NATS: no definir `NATS_URL` o apuntar a un puerto cerrado. La API debe loguear `event_bus.degraded` y responder `/health` 200 y `/health/ready` 200 si Postgres está bien (`checks.eventBus: degraded`).

---

## Uso desde dominio (oleadas siguientes)

```ts
import { Inject } from '@nestjs/common';
import { EVENT_BUS, EventSubjects, type EventBus, buildHeaders } from '../messaging';

constructor(@Inject(EVENT_BUS) private readonly eventBus: EventBus) {}

await this.eventBus.publish(EventSubjects.INCIDENTS_CREATED, {
  payload: { incidentId, tenantId },
  headers: buildHeaders({ tenantId, correlationId, incidentId }),
  idempotencyKey: `${tenantId}:incidents.created:${incidentId}`,
});
```

Prohibido importar `@nats-io/*` o `NatsJetStreamEventBus` desde `aiops/`, `ingest/`, etc.

---

## Limitaciones

- Sin outbox en PostgreSQL: si NATS está degradado, el publish falla; el ingest HTTP no encola al bus todavía.
- Idempotencia de aplicación in-memory: no es compartida entre réplicas.
- `seek` en JetStream elimina el durable para que el siguiente `subscribe` lo recree; no reposiciona in-place.
- Request/reply NATS es core, no persistente en JetStream.
- NATS sigue sin auth (token/nkey) en el server actual; SPOF de 1 réplica sin cambios.
- `main.ts` no llama `enableShutdownHooks()` (fuera de ownership); el módulo registra `SIGTERM`/`SIGINT` para cerrar el bus.
- No hay consumers de producto (correlación, RCA, AIOps) en esta oleada.
