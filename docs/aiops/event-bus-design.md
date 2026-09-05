# Diseño: EventBus AIOps (NATS JetStream)

**Estado:** diseño — no implementado.  
**Fecha:** 2026-09-04  
**Alcance:** abstracción `EventBus` + primera implementación `NatsJetStreamEventBus`.  
**Fuera de alcance:** código de producto, microservicio enorme de mensajería, `MASTER-IMPLEMENTATION-PLAN.md`.

Nomenclatura:

| Término | Significado en este documento |
|---|---|
| **Ekumetrics Agent** | Recolector en infra del cliente (telemetría, discovery, SNMP, LLDP). Publica señales *raw* hacia la plataforma. |
| **AIOps Agent** | Agente lógico de investigación dentro de la plataforma (`RcaAgent`, `MetricsAgent`, etc.). Consume/produce eventos de dominio AIOps. |
| **EventBus** | Puerto de mensajería de la plataforma. El dominio habla solo con esta interfaz. |

---

## 1. Inventario: ¿qué hay hoy?

### 1.1 Hallazgo principal

| Capacidad | ¿Existe? | Dónde | Uso real |
|---|---|---|---|
| **NATS server + JetStream** | Sí | Docker Compose + Kubernetes | Infra desplegada; **ningún cliente de aplicación lo usa** |
| Cliente `nats` / JetStream en platform-api | No | — | `package.json` de platform-api no declara `nats`; no hay `EventBus` |
| Redis Streams / BullMQ / Kafka interno | No | — | Redis/Kafka/Rabbit aparecen solo como **objetivos de monitoreo** del Ekumetrics Agent |
| Bus de dominio AIOps | No | — | Correlación e incidentes hoy son **síncronos** (HTTP/servicios Nest + PostgreSQL) |

### 1.2 Evidencia de infra

- **Docker:** `ekumetrics-platform/infrastructure/docker/docker-compose.yml` → servicio `nats:2.14.5-alpine`, puertos `4222` / `8222`, volumen `nats-data`.
- **Config JetStream (local y k8s, idéntica en lo esencial):**

```text
jetstream {
  store_dir: /data
  max_memory_store: 256MB
  max_file_store: 10GB
}
max_payload: 8MB
```

- **Kubernetes:** `ekumetrics-platform/infrastructure/k8s/nats.yaml` — Deployment 1 réplica, PVC Longhorn `10Gi`, Service `nats:4222` + monitor `8222`, estrategia `Recreate`.
- **Ops:** `docs/operations.md` ya trata retención, backup y límites de JetStream (10 GB disco / 256 MB memoria).

### 1.3 Flujo actual de eventos (sin bus)

```text
Ekumetrics Agent
  └─ mTLS → Agent Edge
       ├─ OTLP → OTel Collector → Prometheus / Loki / Tempo
       └─ HTTP /v1/ekms/events → platform-api IngestService → PostgreSQL
            (idempotencia SHA-256 por fingerprint; 202 tras commit)
```

La arquitectura documentada (`ekumetrics-platform/docs/architecture.md`) **no menciona NATS** en el flujo de datos. NATS está provisionado “para cuando se necesite”, no cableado.

### 1.4 AIOps actual en el monolito Nest

Módulo `apps/platform-api/src/aiops/` (`CorrelationService`, `GraphService`, `IncidentsController`):

- Correlación disparada por API (Alertmanager overview → grafo → `incident.create`).
- Sin publish/subscribe interno.
- Encaja con el pipeline objetivo (Agent → correlación → incident → RCA → orquestador → ITSM/remediación), pero hoy todo es llamada directa.

### 1.5 Conclusión del inventario

**NATS JetStream ya es el bus físico del stack.** Falta la capa de aplicación: puerto `EventBus`, implementación JetStream, streams/consumers y el puente desde ingest/correlación hacia subjects de dominio — **dentro de platform-api**, no como microservicio nuevo.

---

## 2. Principios de diseño

1. **Puerto/adaptador:** el dominio solo depende de `EventBus` + tipos neutros (`CloudEvent`-like o envelope propio). Cero imports de `nats` fuera del adaptador.
2. **Una implementación ahora:** `NatsJetStreamEventBus`. Contrato listo para `KafkaEventBus` / `InMemoryEventBus` (tests) sin tocar handlers.
3. **No microservicio de mensajería:** Nest monolito + NATS como sidecar/servicio de cluster (ya existe). Workers = mismos procesos Nest (o réplicas) con durable consumers.
4. **Tenant-first:** todo mensaje lleva `tenantId` (header obligatorio + campo en payload). Consumers filtran/validan; nunca cruzar tenants.
5. **At-least-once + idempotencia de aplicación:** JetStream garantiza entrega; el consumidor debe ser idempotente (clave + store).
6. **Raw vs dominio:** subjects `*.raw` son frontera del Ekumetrics Agent / ingest; el resto es dominio platform/AIOps.
7. **Compatibilidad con ingest HTTP:** en fase 1 el Agent **sigue** publicando por HTTP; la API, tras persistir (o en paralelo controlado), publica al bus. No exigir NATS en el edge del cliente en MVP.

---

## 3. Abstracción `EventBus`

### 3.1 Ubicación propuesta del código

```text
ekumetrics-platform/apps/platform-api/src/messaging/
  messaging.module.ts                 # Nest module; token EVENT_BUS
  event-bus.ts                        # interface EventBus + tipos
  subjects.ts                         # constantes de subjects (única fuente)
  envelopes.ts                        # EventEnvelope, headers tipados
  idempotency/
    idempotency-store.ts              # interface
    prisma-idempotency-store.ts       # tabla message_dedupe (recomendado)
  adapters/
    nats-jetstream.event-bus.ts       # ÚNICO sitio que importa 'nats'
    in-memory.event-bus.ts            # tests unitarios / e2e locales sin NATS
  consumers/                          # handlers thin → llaman servicios de dominio
    *.consumer.ts
  __tests__/
    event-bus.retry.spec.ts
    event-bus.idempotency.spec.ts
    nats-jetstream.integration.spec.ts  # opcional, marca e2e
```

**No** crear `apps/event-bus-service` ni repo aparte en esta fase.

Opcional más adelante: extraer solo el puerto + adaptador a `packages/messaging` si otro binario Nest (worker) lo comparte; el worker seguiría siendo un entrypoint ligero del mismo monorepo, no un producto nuevo.

### 3.2 Contrato (tipos conceptuales)

```ts
/** Puerto. El dominio depende solo de esto. */
interface EventBus {
  publish<T>(subject: string, message: OutboundMessage<T>): Promise<PublishResult>;
  subscribe<T>(opts: SubscribeOptions, handler: MessageHandler<T>): Promise<Subscription>;
  /** Replay / catch-up: posicionar consumer durable (implementación decide mapping). */
  seek?(consumer: string, position: SeekPosition): Promise<void>;
  close(): Promise<void>;
}

type OutboundMessage<T> = {
  payload: T;
  headers: EventHeaders;       // ver §6
  /** Idempotencia de publicación (dedupe en productor / Msg-Id JetStream). */
  idempotencyKey: string;
  /** Opcional: subject de DLQ override; default = subject + '.dlq' o stream DLQ. */
  deadLetterSubject?: string;
};

type EventHeaders = {
  tenantId: string;            // obligatorio
  siteId?: string;
  agentId?: string;            // Ekumetrics Agent id cuando aplica
  incidentId?: string;
  correlationId: string;       // traza de negocio end-to-end
  causationId?: string;        // mensaje padre
  contentType: 'application/json';
  schemaVersion: string;       // p.ej. '1'
  producedBy: string;          // servicio / componente
  occurredAt: string;          // ISO-8601
};

type SubscribeOptions = {
  subject: string;             // o patrón si el adaptador lo soporta
  consumerName: string;        // durable name estable
  queueGroup?: string;         // competencia entre réplicas
  maxDeliveries: number;       // antes de DLQ
  ackWaitMs: number;
  backoffMs: number[];         // p.ej. [1_000, 5_000, 30_000, 120_000]
  filterTenantId?: string;     // opcional en tests; prod valida en handler
  startPolicy?: 'new' | 'all' | 'timestamp' | 'sequence';
  startAt?: string | number;
};

type InboundMessage<T> = {
  subject: string;
  payload: T;
  headers: EventHeaders;
  idempotencyKey: string;
  attempt: number;
  /** Token opaco para ack/nak; dominio no interpreta NATS. */
  ackRef: AckRef;
};

type MessageHandler<T> = (msg: InboundMessage<T>, ctrl: MessageControl) => Promise<void>;

interface MessageControl {
  ack(): Promise<void>;
  nak(delayMs?: number): Promise<void>;
  /** Terminar sin reintento; va a DLQ con razón. */
  term(reason: string): Promise<void>;
}

type PublishResult = { messageId: string; duplicate?: boolean };
type SeekPosition =
  | { type: 'sequence'; seq: number }
  | { type: 'timestamp'; iso: string }
  | { type: 'all' }
  | { type: 'new' };
```

Reglas:

- Handlers de dominio reciben `InboundMessage` y usan solo `MessageControl` (ack/nak/term).
- **Prohibido** pasar `JsMsg`, `NatsConnection` o subjects NATS crudos a `CorrelationService`, `RcaAgent`, etc.
- `subscribe` registra un durable consumer; en Nest, el `OnModuleInit` del consumer llama a `eventBus.subscribe(...)`.

### 3.3 Capacidades → mapping

| Capacidad | Puerto `EventBus` | JetStream (adaptador) |
|---|---|---|
| publish | `publish` | `js.publish` + header `Nats-Msg-Id` = `idempotencyKey` |
| subscribe | `subscribe` | `consumer.consume` / push o pull durable |
| durable consumers | `consumerName` | Durable consumer name |
| ack | `ctrl.ack()` | `msg.ack()` |
| nak + retry | `ctrl.nak(delay)` | `msg.nak(delay)` + `max_deliver` |
| backoff | `backoffMs[]` | Consumer backoff / nak delay escalonado |
| dead-letter | tras `maxDeliveries` o `term` | Subject/stream `*.dlq` o stream `EKU_DLQ` |
| replay | `seek` / `startPolicy` | `DeliverPolicy` + `OptStartSeq` / `OptStartTime` |
| idempotency | key + store | Msg-Id (broker) + tabla app (handler) |

---

## 4. Implementación `NatsJetStreamEventBus`

### 4.1 Streams propuestos (agrupación)

Agrupar subjects en pocos streams (límites de retención y ACL más simples):

| Stream | Subjects | Retención sugerida (MVP) | Notas |
|---|---|---|---|
| `EKU_AGENT_RAW` | `ekumetrics.agent.>` | 24–72 h / 2–5 GB | Alta cardinalidad; no bloquear disco de dominio |
| `EKU_EVENTS` | `ekumetrics.events.>` | 7 d | Normalizados / correlacionados |
| `EKU_TOPOLOGY` | `ekumetrics.topology.>` | 7 d (o compact por entidad más adelante) | Entidades y relaciones |
| `EKU_ANOMALIES` | `ekumetrics.anomalies.>` | 7 d | |
| `EKU_INCIDENTS` | `ekumetrics.incidents.>` | 30 d | Auditoría operativa |
| `EKU_RCA` | `ekumetrics.rca.>` | 14 d | |
| `EKU_AI` | `ekumetrics.ai.>` | 14 d | Investigaciones AIOps |
| `EKU_ITSM` | `ekumetrics.itsm.>` | 30 d | |
| `EKU_REMEDIATION` | `ekumetrics.remediation.>` | 30 d | Solo acciones aprobadas |
| `EKU_DLQ` | `ekumetrics.dlq.>` | 30 d | Mirror/forward desde fallos |

Storage: **file** (ya configurado). Réplicas JetStream: 1 en single-node (hoy); documentar paso a cluster NATS + R3 cuando haya HA.

### 4.2 Semántica de consumo

- **Work-queue / queue group** por consumer lógico (`ingest-normalizer`, `correlation-worker`, `rca-worker`, …) para que N réplicas de platform-api no procesen el mismo mensaje dos veces *en paralelo*.
- **Ack explícito** tras éxito de dominio (o tras marcar idempotencia “ya aplicado”).
- Fallo transitorio → `nak(backoffMs[attempt])`.
- Fallo permanente / poison → `term` → publicar copia a `ekumetrics.dlq.<original-subject>` con headers `dlqReason`, `originalSubject`, `attempt`.
- **Replay operativo:** recrear consumer durable con `DeliverPolicy=ByStartSequence|ByStartTime`, o API admin interna (protegida) que llame `seek`. No exponer replay libre al portal en MVP.

### 4.3 Configuración

Variables (nombres ilustrativos):

```text
NATS_URL=nats://nats:4222
NATS_TOKEN=...                 # cuando se active auth
EVENT_BUS_DRIVER=nats          # | memory
EVENT_BUS_CONNECT_TIMEOUT_MS=5000
```

Health: readiness de platform-api puede incluir ping NATS; degradación documentada si el bus cae (ingest HTTP sigue pudiendo persistir en PG y encolar “outbox” — ver §7).

---

## 5. Catálogo de subjects iniciales

Convención: `ekumetrics.<dominio>.<objeto>[.<verbo>]`.  
Productor/consumidor = *rol lógico* (puede vivir en el mismo proceso Nest).

| Subject | Propósito | Productor esperado | Consumidor esperado |
|---|---|---|---|
| `ekumetrics.agent.telemetry.raw` | Lotes/señales de telemetría cruda del recolector (o proyección post-ingest) | Ekumetrics Agent vía edge→API bridge; o `IngestService` tras HTTP | Normalizer / Metrics pipeline |
| `ekumetrics.agent.discovery.raw` | Hallazgos discovery (SNMP/LLDP/inventario crudo) | Ekumetrics Agent / Ingest bridge | Topology builder |
| `ekumetrics.events.normalized` | Eventos de dominio canónicos (post-fingerprint, schema estable) | Normalizer | Correlación, anomalías, UI feeds |
| `ekumetrics.events.correlated` | Grupos correlacionados / ventanas cerradas | CorrelationService (async) | Creador de incidentes, RCA kickoff |
| `ekumetrics.topology.entities` | Upserts de nodos de topología | Topology ingest / GraphService | Graph store, impact analysis |
| `ekumetrics.topology.relationships` | Upserts de aristas | Topology ingest / GraphService | Graph store, blast radius |
| `ekumetrics.anomalies.detected` | Anomalías detectadas (métricas/logs/reglas) | Metrics/anomaly detectors | Correlación, AIOps selección |
| `ekumetrics.incidents.created` | Nuevo incidente persistido | Correlation / incident writer | AgentOrchestrator, notificaciones, ITSM policy |
| `ekumetrics.incidents.updated` | Cambio de estado/severidad/contexto | Incident domain | Portal SSE/poll, orquestador, audit |
| `ekumetrics.rca.requested` | Pedido de RCA determinista | Orchestrator / policy tras incident | RcaAgent |
| `ekumetrics.rca.completed` | Resultado RCA + evidencia resumida | RcaAgent | Orchestrator, Synthesis, portal |
| `ekumetrics.ai.investigation.requested` | Investigación multi-agente (AIOps) | AgentOrchestrator | Metrics/Logs/K8s/… agents |
| `ekumetrics.ai.investigation.completed` | Findings + síntesis lista | Synthesis / Orchestrator | Portal, ITSM, remediation gate |
| `ekumetrics.itsm.ticket.requested` | Abrir/actualizar ticket externo | Policy post-síntesis | ITSM adapter |
| `ekumetrics.remediation.requested` | Acción de remediación **ya aprobada** | Remediation gate | Remediation executor (nunca investigación) |

**Notas de frontera:**

- `*.raw`: no acoplar AIOps Agents a payloads del recolector; solo normalizers.
- `remediation.requested`: contrato estricto (allowlist de acciones); el bus no autoriza — la política lo hace *antes* de publicar.
- HolmesGPT, si se usa, es **tool layer** del Kubernetes Agent, no productor canónico de estos subjects.

### 5.1 Flujo objetivo (alineado a AIOps)

```text
Ekumetrics Agent
  → telemetry.raw / discovery.raw
  → events.normalized (+ topology.*)
  → anomalies.detected
  → events.correlated
  → incidents.created / updated
  → rca.requested → rca.completed
  → ai.investigation.requested → … → ai.investigation.completed
  → itsm.ticket.requested | remediation.requested
```

---

## 6. Headers, tenant e idempotency keys

### 6.1 Tenant

| Canal | Contenido |
|---|---|
| **Header** `tenantId` | Obligatorio en todo publish; validado en subscribe antes del handler de dominio |
| **Payload** | Incluir `tenantId` (y `siteId`/`agentId` cuando aplique) para auditorías y replay offline |
| **Regla** | Si header ≠ payload → `term` (poison) + métrica de seguridad |

No usar wildcard de tenant en un solo consumer multi-tenant sin filtro: un proceso procesa todos los mensajes pero **cada** operación de dominio recibe `tenantId` del mensaje y lo pasa a Prisma/queries (igual que hoy en ingest/retrieval).

### 6.2 Idempotency key

Formato recomendado (estable, reproducible):

```text
{tenantId}:{subject}:{negocioNaturalKey}
```

Ejemplos:

| Subject | Clave natural |
|---|---|
| `agent.telemetry.raw` / eventos ingest | fingerprint SHA-256 ya usado en `IngestService` |
| `incidents.created` | `incidentId` |
| `rca.requested` | `incidentId:rca:v{schema}` |
| `ai.investigation.requested` | `investigationId` o `incidentId:investigation:{runId}` |
| `itsm.ticket.requested` | `incidentId:itsm:{action}` |

Capas:

1. **Broker:** `Nats-Msg-Id` = idempotency key → publish duplicado no crea segundo mensaje en el stream (dentro de la ventana JetStream).
2. **Aplicación:** tabla `MessageDedupe(idempotencyKey, consumerName, processedAt, resultRef)` — el consumer, antes de mutar, comprueba; si ya procesó → `ack` sin reaplicar.

La capa 2 es obligatoria para handlers no puramente idempotentes (crear ticket ITSM, remediación).

### 6.3 Correlation / causation

- `correlationId`: un incidente o lote de investigación lo propaga de punta a punta.
- `causationId`: `messageId` del evento que disparó este publish (cadena causal para debug).

---

## 7. Encaje en el stack (recomendación)

### 7.1 Dónde vive

| Opción | Veredicto |
|---|---|
| **A. Módulo `messaging` dentro de platform-api** | **Recomendada** |
| B. Microservicio “event-router” aparte | No en esta fase — duplica deploy, auth, tenant y observa poco beneficio |
| C. Solo outbox en PG sin NATS | Pierde la infra ya pagada; útil solo como patrón *complementario* |

Patrón híbrido recomendado para robustez:

```text
Ingest HTTP → TX PostgreSQL (fuente de verdad + outbox row)
           → outbox publisher → EventBus.publish(normalized/raw)
```

Así un NATS caído no pierde el commit de ingest; el publisher reintenta. El Agent **no** habla NATS en MVP.

### 7.2 Workers

- Misma imagen `platform-api`, mismas réplicas: consumers registrados en bootstrap.
- Si el CPU de investigación satura la API HTTP: segundo Deployment `platform-api-worker` con `ROLE=worker` (mismo código, sin listeners HTTP públicos) — **no** es un microservicio de dominio nuevo.
- `AgentOrchestrator`, Rca, Synthesis permanecen servicios Nest inyectables; los `*.consumer.ts` solo traducen mensaje → llamada de dominio.

### 7.3 Relación con OTLP

OTLP (métricas/logs/trazas) **sigue** por Collector → Prometheus/Loki/Tempo. El EventBus no sustituye telemetría de series temporales; transporta **eventos de control y dominio AIOps** (y opcionalmente proyecciones raw del contrato `/v1/ekms/events`).

---

## 8. Impacto Kubernetes / Docker

### 8.1 Ya desplegado

- Servicio DNS interno: `nats:4222`.
- PVC JetStream, probes `/healthz`, límites de recursos modestos.

### 8.2 Cambios de diseño (cuando se implemente)

1. **platform-api Deployment:** env `NATS_URL`, secret de auth cuando se endurezca NATS; dependencia de orden (wait/retry, no `dependsOn` rígido).
2. **NetworkPolicy:** permitir egress platform-api → nats:4222; denegar acceso al Agent edge hacia NATS (el Agent no debe publicar directo al bus del cluster en MVP).
3. **Auth NATS:** hoy el conf no muestra token/nkey; **antes de producción con datos reales**, activar autenticación y cuentas (al menos user `platform` con permisos de publish/subscribe a `ekumetrics.>`).
4. **HA:** Deployment NATS `replicas: 1` + `Recreate` es SPOF. Fase posterior: NATS cluster ≥3 + JetStream réplicas; ampliar PVC/alertas (ops ya tiene umbrales de disco).
5. **Métricas:** scrapear `8222` (ya patrón en el Agent como target de colas); alertas de lag de consumer, DLQ depth, `max_file_store`.
6. **Docker Compose local:** sin cambios de topología; solo cablear la API al servicio `nats` existente.
7. **No añadir Redis Streams** en paralelo — evita dos semánticas de cola.

### 8.3 Capacidad

Con `max_file_store: 10GB` y subjects raw, dimensionar retención corta en `EKU_AGENT_RAW` y alertar antes de rechazo de writes (ops ya documenta el síntoma).

---

## 9. Estrategia de tests (sin implementar ahora)

| Capa | Qué valida | Driver |
|---|---|---|
| Unitario puerto | publish → handler recibe envelope; headers tenant | `InMemoryEventBus` |
| Retry / backoff | handler falla N-1 veces con `nak`; ack en N | InMemory con simulación de attempts |
| Failure → DLQ | tras `maxDeliveries`, mensaje en subject DLQ con razón | InMemory o JetStream testcontainer |
| Idempotency | mismo `idempotencyKey` dos veces → una sola mutación de dominio | store fake + spy en servicio |
| Integration | streams creados, durable revive tras restart del consumer | NATS en CI (compose service) opcional |
| Contrato multi-tenant | mensaje tenant A no muta datos tenant B | tests de handler con Prisma test DB |

Casos mínimos a cubrir cuando exista código:

1. `nak` reentrega con `attempt` creciente y delays de `backoffMs`.
2. Excepción no recuperable → `term` + DLQ; no bucle infinito.
3. Reentrega tras ack perdido: segunda entrega con misma key → no duplica incidente/ticket.
4. Replay desde secuencia S: consumer reprocesa; idempotency evita side effects.
5. Publish con `Nats-Msg-Id` duplicado → `PublishResult.duplicate` / no segundo delivery.

---

## 10. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| NATS SPOF (1 réplica) | Pérdida de cola / escritura rechazada | Outbox en PG; HA JetStream en prod; alertas de disco |
| Acoplar dominio a NATS | Imposible migrar a Kafka | Strict module boundary; lint/ban `nats` fuera de `adapters/` |
| Doble procesamiento | Tickets/remediaciones duplicadas | Idempotency store por `(consumerName, key)` |
| Subjects raw saturan 10 GB | JetStream deja de aceptar | Retención corta RAW; backpressure; no espejar OTLP completo al bus |
| Agent publicando NATS directo | Expone bus, complica mTLS/edge | Mantener HTTP ingest + bridge en API |
| Consumers en el mismo proceso HTTP | Latencia API bajo carga AIOps | Split `ROLE=worker` cuando haga falta |
| Falta auth en NATS | Cualquier pod en la red publica | Tokens/nkeys antes de multi-tenant hostil |
| Replay sin idempotencia | Corrupción de estado | Replay solo con store; runbooks operativos |

---

## 11. Fases sugeridas (diseño, no plan maestro)

1. **Puerto + InMemory + NatsJetStream** en platform-api; crear streams; health.
2. **Bridge ingest →** `events.normalized` / `agent.*.raw` vía outbox.
3. **Consumers** correlación / incidentes (`events.correlated`, `incidents.*`).
4. **RCA + AI investigation** subjects; Orchestrator por mensajes.
5. **ITSM + remediation** con idempotencia estricta y DLQ monitorizada.
6. **Endurecer** auth NATS, HA, empaquetar worker Deployment si escala.

---

## 12. Resumen ejecutivo

1. **Sí hay NATS JetStream hoy** en Docker y Kubernetes (`nats:2.14.5`, store 10 GB); **no** hay cliente ni EventBus en platform-api ni en el Agent.
2. Redis/Kafka no son bus de plataforma; solo targets de discovery/métricas del recolector.
3. Encaje: módulo `messaging` **dentro del monolito Nest** + NATS ya desplegado; opcional Deployment worker del mismo binario.
4. Dominio solo ve `EventBus`; `NatsJetStreamEventBus` es el único adaptador con SDK NATS; Kafka queda como segundo adaptador futuro.
5. Agent sigue por HTTP/OTLP; la API publica al bus tras persistir (outbox).
6. Subjects listados cubren raw → normalizado → topología → anomalías → incidentes → RCA → investigación AIOps → ITSM/remediación.
7. Idempotencia en dos capas (Msg-Id + tabla por consumer); tenant en header y payload.
8. Riesgos principales: SPOF NATS, saturación de store, falta de auth, y side effects sin dedupe.
9. No crear microservicio enorme de mensajería en esta fase.
10. Este documento es diseño únicamente; no modifica código de producto.
