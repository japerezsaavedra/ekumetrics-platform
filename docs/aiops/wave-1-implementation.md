# Wave 1 AIOps — implementación consolidada

**Estado:** merge central verificado. Sin loop multi-agente. Sin orquestación LLM.  
**Fecha:** 2026-09-04  
**Repo de código:** `ekumetrics-platform` (rama `dev`, sin commit de esta oleada).  
**Nomenclatura:** **Ekumetrics Agent** = recolector (`ekumetrics-agent/`). **AIOps Agent** = investigador lógico (`RcaAgent`, `MetricsAgent`, `AgentOrchestrator`) en `platform-api`. HolmesGPT no orquesta.

Workstreams de origen: [Event Bus](wave-1-event-bus.md), [Event domain](wave-1-event-domain.md), [Correlation V2](wave-1-correlation.md), [Topology V2](wave-1-topology.md), [Domain foundation](wave-1-domain-foundation.md).

---

## Files changed

### EventBus (`platform-api/src/messaging/`)

| Path | Rol |
|---|---|
| `event-bus.ts` | Puerto: publish / subscribe / request / close |
| `nats-jetstream.event-bus.ts` | Único import de `@nats-io/*` |
| `in-memory.event-bus.ts` | Tests y `EVENT_BUS_DRIVER=memory` |
| `degraded.event-bus.ts` | NATS caído o sin `NATS_URL`; la API arranca |
| `subjects.ts` | Catálogo de subjects |
| `messaging.module.ts` | Factory + lifecycle SIGTERM/SIGINT |
| `idempotency.ts`, `envelopes.ts`, `errors.ts`, `tokens.ts`, `tracing.ts`, `log.ts` | Infra del puerto |
| `*.spec.ts` | Unitarios; integración JetStream skip salvo `EVENT_BUS_INTEGRATION=1` |

Cableado: `AppModule` importa `MessagingModule` (global). `HealthController` reporta `checks.eventBus` informativo.

### AgentEvent / ingest

| Path | Rol |
|---|---|
| `prisma/schema.prisma` (`AgentEvent`) | Columnas AIOps opcionales + índices tenant-scoped |
| `prisma/migrations/20260904233000_agent_event_aiops_metadata/` | SQL + backfill best-effort |
| `src/ingest/ingest.types.ts` | Envelope: campos opcionales + inferencia |
| `src/ingest/ingest.service.ts` | Persistencia; `tenantId` = `Tenant.id` |
| `packages/shared-contracts/openapi/platform-v0.yaml` | `EkmsEvent` + `EkmsEventMetadata` |

### Correlation V2

| Path | Rol |
|---|---|
| `src/aiops/correlation.service.ts` | Motor evolucionado (Alertmanager + grafo) |
| `src/aiops/correlation-score.ts` | Scoring puro 0..1 |
| `src/aiops/correlation-weights.ts` | Defaults + env, normalización a 1 |
| `src/aiops/correlation-types.ts` | `CorrelationScore` / evidencia |
| `src/aiops/correlation-metrics.ts` | Prometheus (`registerContributor`) |
| `src/aiops/correlation*.spec.ts` | Compat V1, scoring, tenant isolation |

### Topology V2

| Path | Rol |
|---|---|
| `src/aiops/topology.repository.ts` | Puerto `TOPOLOGY_REPOSITORY` |
| `src/aiops/topology.postgres.repository.ts` | Impl. sobre `GraphService` / Postgres |
| `src/aiops/topology.relations.ts` | Catálogo de relaciones (no enum Prisma) |
| `src/aiops/topology-walk.ts` | BFS dirigido / no dirigido |
| `src/aiops/graph.service.ts` | `upsertRelation` + `confidence` opcional |
| `prisma/migrations/20260904230000_topology_v2/` | `GraphEdge.confidence` + índices |

### Domain foundation (contratos + persistencia; stubs)

| Path | Rol |
|---|---|
| `src/aiops/types/` | `AgentFinding`, `AiopsInvestigation`, RCA types (transitorios) |
| `src/aiops/interfaces/` | `RcaEngine`, `AiopsAgent`, `AgentOrchestrator` |
| `src/aiops/stubs/` | Sin tools, sin LLM, `run()` → `QUEUED` |
| `src/aiops/persistence/` | Repositorios con `tenantId` obligatorio |
| `src/aiops/aiops-domain.module.ts` | Providers / tokens Nest |
| `prisma/migrations/20260904123000_aiops_domain_foundation/` | Tablas + enums |

### Infra

| Path | Cambio |
|---|---|
| `infrastructure/docker/docker-compose.yml` | `NATS_URL: nats://nats:4222` en `platform-api` (servicio `nats` existente) |
| `infrastructure/k8s/kustomization.yaml` | `NATS_URL=nats://nats:4222` en ConfigMap; un solo Deployment `nats` |

### Merge central (esta tarea)

| Path | Qué |
|---|---|
| `src/aiops/persistence/agent-finding.repository.ts` | Cast `Prisma.InputJsonValue` para `evidence` / `toolCalls` / `errors` (el `nest build` fallaba; Jest no type-checkea Prisma Json) |
| Wave-1 `*.ts` de messaging / ingest / correlation | `prettier --write` (no se reformateó auth/kiosk/boards preexistente) |

`portal-web` **no** importa `shared-contracts`; no se reconstruyó.

---

## Schema

`schema.prisma` ya coexistía; no hubo que fusionar a mano ni reordenar migraciones. Las tres migraciones wave 1 tocan objetos distintos:

| Migración | Objetos |
|---|---|
| `20260904123000_aiops_domain_foundation` | Enums `AgentFindingStatus`, `AiopsInvestigationStatus`, `IncidentLifecycle`; tablas `AiopsInvestigation`, `AgentFinding`; FK a `Tenant` + `investigationId` cascade |
| `20260904230000_topology_v2` | `GraphEdge.confidence` nullable; índices `(GraphNode.tenantId, kind)`, `(GraphEdge.tenantId, relation)` |
| `20260904233000_agent_event_aiops_metadata` | `AgentEvent.category`, `entityType`, `correlationKey`, `environment`, `traceId`, `metadata`; índices tenant-scoped |

También presente (fuera de las 5 workstreams AIOps, no borrada): `20260903120000_tenant_modules` (`Tenant.modules`).

**AgentEvent (nuevo, todo nullable):** `category`, `entityType`, `correlationKey`, `environment`, `traceId`, `metadata` (Json). Reutilizado: `severity`, `value`, `signal`, `assetKey`/`assetType`, `tags`, `fingerprint`, `tenantId`, `siteId`, `eventAt`.

**GraphEdge:** `confidence Float?`. `createdAt` = firstSeen; `lastSeenAt` = lastSeen; `source` ya existía.

**Incident.status:** sin cambio (`open` \| `acknowledged` \| `resolved` \| `closed`). El lifecycle AIOps vive en `AiopsInvestigation.incidentLifecycle` (opcional). `incidentId` en findings/investigaciones es FK lógica (sin relación Prisma a `Incident`).

`npx prisma validate` OK. `npx prisma generate` OK. No se usó `migrate reset`.

---

## NATS subjects

Único catálogo: `src/messaging/subjects.ts`.

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

DLQ: `ekumetrics.dlq.<subject-original>`. Streams JetStream al conectar: `EKU_EVENTS`, `EKU_TOPOLOGY`, `EKU_INCIDENTS`, `EKU_RCA`, `EKU_AIOPS`, `EKU_DLQ`.

**Wave 1 no cablea productores/consumidores de producto.** Ingest, correlación y topología no publican al bus. El puerto existe; el dominio no importa `@nats-io/*`.

Variables: `NATS_URL`, `NATS_TOKEN` (opcional), `EVENT_BUS_DRIVER` (`nats` \| `memory`; default `memory` si `NODE_ENV=test`), `EVENT_BUS_CONNECT_TIMEOUT_MS`.

---

## API changes

HTTP de producto **sin rutas nuevas** de investigación multi-agente.

| Superficie | Cambio |
|---|---|
| `POST /v1/ekms/events` | Acepta opcionales AIOps (`category`, `entity_type`, `correlation_key`, `environment`, `trace_id`, `metadata`). Required sin cambio. OpenAPI `EkmsEvent` / `EkmsEventMetadata`. Señales documentadas: `neighbor_observed`, `metric.anomaly`, `log.signal`, `change.detected`, `deploy.observed`, `alert.received`. |
| `POST /v1/incidents/correlate` | Sigue on-demand. `Incident.members.correlation` (score V2 explicable). `Incident.confidence` = heurística V1. |
| `GET /v1/incidents`, `GET /v1/graph*` | Contratos previos. Snapshot de arista añade `confidence` / `firstSeenAt` / `lastSeenAt` opcionales; Cytoscape sigue usando `from` / `to` / `relation`. |
| `GET /health` | Liveness; no depende del bus. |
| `GET /health/ready` | Exige Postgres. `checks.eventBus`: `ok` \| `degraded` (informativo; no tumba readiness). |
| `GET /metrics` | Series `aiops_correlation_duration_seconds`, `aiops_correlations_total{outcome=...}`. |

OpenAPI: solo el envelope de ingest. Tipos RCA / `AiopsAgent` / orquestador **no** están en `shared-contracts` (viven en `src/aiops/types` e `interfaces`).

---

## Behavior

1. **Mensajería.** `MessagingModule` elige JetStream, memory o `DegradedEventBus`. Durable consumers, ack explícito, retry + backoff, DLQ, request/reply, idempotencia broker (`Nats-Msg-Id`) + store in-memory por proceso.
2. **Ingest.** Envelopes viejos válidos. Inferencia: `category` ← `signal`, `entityType` ← `asset_type`, `environment` ← `tags.environment`, `traceId` ← `tags.trace_id`/`traceId`. Fingerprint de envelopes antiguos **no cambia**.
3. **Correlación.** Cluster V1 (sitio + ventana + `sharePath`). Score V2: temporal / entidad / topología / labels / histórico, pesos por env (`AIOPS_CORRELATION_WEIGHT_*`, ventana, hops). Evidencia incluye que coincidencia temporal ≠ causalidad. Dedup de alertas por fingerprint. Enriquecimiento `AgentEvent` por `(tenantId, fingerprint)`.
4. **Topología.** `PostgresTopologyRepository` envuelve el grafo existente. LLDP sigue `CONNECTS_TO`. `graph-walk.ts` intacto para correlación. `HOSTS` inverso de `RUNS_ON`.
5. **Dominio AIOps.** `RcaEngine.propose()` → `[]`. `RcaAgentStub.investigate()` → `SKIPPED`. `AgentOrchestratorStub.select()` aplica política; `run()` no despacha ni persiste (devuelve `QUEUED` en memoria). Repositorios sí persisten `AgentFinding` / `AiopsInvestigation` con `tenantId`.

---

## Backwards compatibility

- Recolector actual: mismo required del envelope; HTTP ingest sin NATS.
- Fingerprint / `skipDuplicates` de envelopes sin campos AIOps: estable.
- `Incident.status` y `clusterKey` (SHA-256 de fingerprints de alerta): sin cambio.
- Filas LLDP: `relation='CONNECTS_TO'`, `confidence` NULL.
- UI `/incidentes`, `/investigacion`, grafo Cytoscape: rutas y forma mínima de arista.
- EkuAssistant / Holmes: paralelo, no es el cerebro AIOps.
- Arranque sin NATS: login, dashboard y HTTP siguen; publish lanza `EventBusUnavailableError`.

---

## Tests

Ejecutados en `apps/platform-api` (`npm test -- --runInBand`):

**42 suites, 217 passed, 1 skipped, 0 failed.**

| Área | Specs | Notas |
|---|---|---|
| Messaging | `event-bus.spec`, `event-bus.retry.spec`, `event-bus.idempotency.spec`, `messaging.module.spec`, `nats-jetstream.integration.spec` | Integración JetStream **skipped** (requiere NATS + `EVENT_BUS_INTEGRATION=1`) |
| Ingest | `ingest.types.spec`, `ingest.service.spec` | Envelope viejo, inferencia, metadata, tenant isolation |
| Correlation | `correlation.service.spec`, `correlation-score.spec`, `correlation-weights.spec`, `correlation-metrics.spec` | V1 + V2 + isolation |
| Topology | `topology-walk.spec`, `topology.postgres.repository.spec`, `topology.repository.spec`, `graph-walk.spec` | Isolation; `graph-walk` intacto |
| Domain | `rca-domain.spec`, `agent-finding.repository.spec`, `investigation.repository.spec`, `aiops-stubs.spec` | Stubs sin LLM; isolation |
| Health | `health.controller.spec` | Ready con `eventBus` degraded/ok |
| Resto producto | auth, dashboard, tenants, AI, alertmanager, kiosk, observability, … | Existentes verdes |

`npm run build` (nest): **OK** tras el cast Json de `AgentFindingRepository`.

### Checklist de verificación (esta tarea)

| Check | Resultado |
|---|---|
| `prisma validate` / `prisma generate` | OK |
| Unit tests platform-api | 217 pass / 1 skip |
| Build platform-api | OK |
| OpenAPI vs ingest | Coherente (`EkmsEvent` opcionales) |
| Build portal-web | **Skip:** portal no importa `shared-contracts` |
| Compose `NATS_URL` | `nats://nats:4222`; un servicio `nats` |
| Kustomize `NATS_URL` | `nats://nats:4222`; un Deployment `nats` |
| `prettier --check` repo-wide | **Falla** en ~40 archivos; muchos preexistentes (auth, boards, kiosk). Se formateó solo wave 1 (messaging, ingest, correlation) |
| `npm run lint` repo-wide | **Falla.** Wave 1: `no-unsafe-assignment` en specs de correlation/ingest; `require-await` en EventBus in-memory/degraded. Preexistente: auth/boards/kiosk. No se rediseñó lint |
| Integración NATS real | **Skip:** no se levantó el broker; spec gated |
| `migrate reset` | **No ejecutado** (destructivo) |

---

## Known limitations

- Sin outbox PostgreSQL: si el bus está degradado, el publish falla; ingest HTTP **no** encola al bus.
- Idempotencia de aplicación in-memory: no compartida entre réplicas.
- Correlación sigue on-demand (`POST /v1/incidents/correlate`), no continua ni consumer NATS.
- Fingerprint Alertmanager ≠ `AgentEvent.fingerprint` en la práctica; el cruce aplica cuando coinciden.
- `Incident.confidence` = V1; el score explicable está en `members.correlation`.
- `TopologyRepository` no publica `ekumetrics.topology.updated`.
- `RcaEngine` no extrae causa del grafo; CorrelationService sigue escribiendo `Incident.cause*`.
- `AgentOrchestrator.run()` no persiste ni llama AIOps Agents (wave 2).
- `RootCauseCandidate` / `RcaEvidence` / `IncidentContext` son tipos transitorios (sin tabla).
- NATS sin auth en el server actual; una réplica.
- Tras NATS caído **en el arranque**, hace falta reiniciar la API para volver a JetStream.
- Lint/format de platform-api no queda limpio a nivel repo (deuda previa + specs `any` de wave 1).

---

## Definition of Done — wave 1

| # | Criterio | Estado |
|---|---|---|
| 1 | platform-api publica/consume vía EventBus (NATS o memory/degraded) | **Cumplido a nivel puerto.** Tests publish/subscribe/request. Dominio (ingest/correlación/topología) **aún no** es productor/consumidor. |
| 2 | EventBus oculta NATS del dominio | **Cumplido.** `@nats-io/*` solo en `nats-jetstream.event-bus.ts` (+ spec de integración). `aiops/` no importa messaging. |
| 3 | AgentEvent cubre metadata AIOps | **Cumplido.** Columnas + OpenAPI + inferencia ingest. |
| 4 | Correlación explicable y pesos configurables | **Cumplido.** `members.correlation` + env `AIOPS_CORRELATION_WEIGHT_*`. |
| 5 | TopologyRepository sobre Postgres | **Cumplido.** `PostgresTopologyRepository` + `GraphEdge.confidence`. |
| 6 | Contratos RCA / AiopsAgent / Orchestrator (stubs OK) | **Cumplido.** Interfaces + stubs en `AiopsDomainModule`. |
| 7 | AgentFinding persistible con tenantId | **Cumplido.** Tabla + repositorio + isolation tests. |
| 8 | Producto actual no roto | **Cumplido.** 217 tests existentes+nuevos verdes; build OK. |
| 9 | Tests tenant isolation | **Cumplido.** Ingest, correlation, topology, AgentFinding, Investigation. |
| 10 | NO hay orquestación LLM | **Cumplido.** Stubs sin Holmes/LLM; `run()` no despacha. EkuAssistant sigue siendo chat paralelo. |

---

## STOP

Wave 1 cerrada a nivel de cimientos. **No implementar Wave 2** (loop multi-agente, Synthesis, consumers de producto, CanonicalEvent, RCA real) hasta aprobación explícita.

**No hay commit** de este merge.
