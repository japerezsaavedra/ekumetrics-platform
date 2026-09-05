# Wave 2 AIOps — implementación consolidada

**Estado:** motores deterministas implementados en `platform-api`. Sin `AgentOrchestrator`. Sin loop multi-agente. Sin Holmes/LLM.  
**Fecha:** 2026-09-05  
**Repo de código:** `ekumetrics-platform`  
**Nomenclatura:** **Ekumetrics Agent** = recolector (`ekumetrics-agent/`). **AIOps Agent** = investigador lógico en plataforma (`RcaAgent`, `MetricsAgent`, …). HolmesGPT no orquesta. Wave 2 añade **motores** (AnomalyEngine, RcaEngine, TopologyCorrelation, enrichment, histórico), no agentes de investigación.

Wave 1 permanece: EventBus, NATS JetStream, CorrelationService V2, TopologyRepository, Incident, GraphNode/GraphEdge, AgentEvent, AiopsInvestigation, AgentFinding, stubs de orquestación. Este documento **no** reabre Wave 1.

Workstreams de origen: [contratos](wave-2-contracts.md), [anomalía](wave-2-task-1-anomaly.md), [RCA](wave-2-task-2-rca.md), [topología](wave-2-task-3-topology.md), [enrichment](wave-2-task-4-enrichment.md), [histórico](wave-2-task-5-historical.md).

---

## Qué quedó hecho (y qué no)

| Capa | Estado real |
|---|---|
| Contratos TS + Prisma Wave 2 | Tablas y tipos en repo |
| AnomalyEngine (4 detectores, sin LLM) | Motor + worker listos |
| RcaEngine determinista (`RcaEngine.propose`) | Motor + subscriber listos |
| TopologyCorrelation sobre Correlation V2 | En el path de `POST /v1/incidents/correlate` |
| Enrichment asíncrono + UI | Tras correlate; panel en `/incidentes` y `/investigacion` |
| Fundación histórica (firma + Jaccard + feedback) | API + store in-memory |
| Adaptadores Prisma de resultado (anomalía, enrichment, firma, feedback, `RcaScoringPolicy`) | **No cableados.** Los módulos de producto usan puertos in-memory |
| Productor `ekumetrics.events.ingested` desde ingest HTTP | **No.** El worker de anomalía espera ese subject |
| Productor `ekumetrics.rca.requested` desde correlación | **No.** El subscriber RCA espera ese subject |
| `AgentOrchestrator` / AIOps Agents reales | **No.** Sigue el stub Wave 1 (`run()` → `QUEUED`; `RcaAgentStub` → `SKIPPED`) |

La UI de producto ve enrichment (timeline, blast radius, candidatos desde `Incident.causeKey`). El ranking `weighted_subscores_v1` corre cuando alguien publica `rca.requested` (hoy: tests o un productor futuro).

---

## Files changed

Rutas relativas a `ekumetrics-platform/apps/platform-api/` salvo que se indique otro árbol.

### Contratos (`src/aiops/contracts/`)

| Path | Rol |
|---|---|
| `index.ts` | Barrel canónico Wave 2 |
| `anomaly.ts`, `enrichment.ts`, `historical.ts`, `rca-scoring-policy.ts`, `rca-feedback.ts` | Tipos compartidos |
| `topology-impact.ts` | `BlastRadius` / impacto |
| `incident-priority.ts`, `explainable.ts`, `events.ts`, `metrics.ts` | Prioridad, evidencia, subjects, nombres Prometheus |
| `wave2-contracts.spec.ts` | Subjects y métricas alineados al catálogo |
| `anomaly/wave2-contracts.ts`, `rca/wave2-contracts.ts`, `topology-correlation/wave2-contracts.ts`, `enrichment/wave2-contracts.ts`, `historical/wave2-contracts.ts` | Reexport fino por workstream (no fork) |

### Anomalía (`src/aiops/anomaly/`)

| Path | Rol |
|---|---|
| `anomaly.engine.ts` | Orquesta detectores, política, persistencia puerto, publish |
| `anomaly.worker.ts` | Consumer `ekumetrics.events.ingested` (`aiops-anomaly-engine`) |
| `anomaly.module.ts` | Nest; importado en `AppModule` |
| `detectors/static-threshold.detector.ts` | Umbrales `PlatformThresholds` |
| `detectors/rolling-baseline.detector.ts` | Mediana / IQR / percentiles |
| `detectors/robust-zscore.detector.ts` | Mediana + MAD |
| `detectors/ewma.detector.ts` | Deriva / residuo |
| `detectors/advanced-stubs.ts` | Change-point, Isolation Forest, seasonal: siempre `[]` |
| `metric-window.store.ts` | Buffer 24 h, tenant-scoped |
| `anomaly.repository.ts` / `anomaly-policy.repository.ts` | Puerto + **in-memory** |
| `platform-threshold.prisma.ts` | Único adaptador Prisma del módulo (lee umbrales; no copia la tabla) |
| `anomaly-metrics.ts`, `anomaly-policy.ts`, `stats.ts`, `metric-sample.ts` | Métricas, defaults, parsing |
| `*.spec.ts` | Jest |

### RCA (`src/aiops/rca/`)

| Path | Rol |
|---|---|
| `engine.ts` | `DeterministicRcaEngine implements RcaEngine` |
| `scorer.ts` / `explain.ts` | Scoring puro + hipótesis |
| `scoring-policy.ts` | Pesos desde `Policy` `kind`/`name` = `rca_scoring`, si no env, si no default |
| `subscriber.ts` | Consume `rca.requested`, publica `rca.completed` (`aiops-rca-engine`) |
| `anomaly-evidence.port.ts` | **Noop** (no lee AnomalyEngine) |
| `historical-evidence.port.ts` | **Neutro 0.5** (no llama `HistoricalService`) |
| `incident-source.ts` | Lee Incident + grafo + AgentEvent |
| `rca.module.ts` | Importado vía `AiopsDomainModule` |
| `*.spec.ts` | Jest |

`RcaAgentStub` **no** se sustituyó: el motor es `RcaEngine`, no un AIOps Agent.

### Topología / correlación (`src/aiops/topology-correlation/` + Correlation V2)

| Path | Rol |
|---|---|
| `topology-correlation.service.ts` | `apply()` tras clustering V2; publish aditivo |
| `topology-correlation.scoring.ts` / `.confidence.ts` / `.config.ts` | Blast radius, camino, noisy-OR, env |
| `topology-correlation.metrics.ts` | `aiops_topology_*` / suppressions |
| `correlation.service.ts` | Inyección opcional + `members.blastRadius` / `suppression` / `topologyEvidence` |
| `correlation-types.ts` | Campos aditivos |
| `incidents.module.ts` | Providers Wave 2 (topología + enrichment) |

No hay segundo grafo. Sigue `TopologyRepository` / `GraphNode` / `GraphEdge`.

### Enrichment (`src/aiops/enrichment/` + controller)

| Path | Rol |
|---|---|
| `incident-enrichment.service.ts` | Snapshot determinista |
| `incident-enrichment.worker.ts` | Consumer `enrichment.requested` → `incidents.enriched` |
| `incident-enrichment.publisher.ts` | Tras correlate; no bloquea si el bus cae |
| `incident-enrichment.repository.ts` | Puerto + **in-memory** |
| `incident-priority.calculator.ts` / `incident-timeline.ts` | Prioridad P1–P4 + timeline |
| `incidents.controller.ts` | `enrichment` opcional; re-enrich; feedback lowercase |

### Histórico (`src/aiops/historical/`)

| Path | Rol |
|---|---|
| `signature.ts` / `similarity.ts` | SHA-256 estable + Jaccard ponderado |
| `historical.service.ts` | Lookup, firma, side-effects de resolución |
| `historical.controller.ts` | API tenant-scoped (acciones **UPPERCASE**) |
| `in-memory.historical.repository.ts` | Store por tenant |
| `historical.module.ts` | Importado en `AppModule` |
| `*.spec.ts` | Jest |

### Mensajería

| Path | Cambio Wave 2 |
|---|---|
| `src/messaging/subjects.ts` | `ANOMALIES_DETECTED`, `INCIDENTS_ENRICHMENT_REQUESTED`, `INCIDENTS_ENRICHED` |
| `src/messaging/nats-jetstream.event-bus.ts` | Stream `EKU_ANOMALIES` (`ekumetrics.anomalies.>`) |

### Prisma

| Path | Rol |
|---|---|
| `prisma/schema.prisma` | Modelos Wave 2 + relaciones en `Incident` / `Tenant` |
| `prisma/migrations/20260905080000_wave2_aiops/migration.sql` | SQL |

No se alteran columnas de `Incident` (salvo relaciones), ni `GraphNode`, `GraphEdge`, `AgentEvent`.

### Portal (`apps/portal-web`)

| Path | Rol |
|---|---|
| `src/app/pages/incidents/incident-enrichment-panel.*` | Panel: anomalías, RCA, radio, timeline, feedback reactivo |
| `src/app/pages/incidents/incident-enrichment.view.ts` | Helpers / empty state |
| `src/app/pages/incidents/incidents-page.*` | `/incidentes` |
| `src/app/pages/investigacion/investigacion-page.*` | `/investigacion` (mismo Cytoscape) |

Formularios reactive (`formControlName`). Sin segundo frontend de topología.

### Cableado Nest

`AppModule` importa `AnomalyModule` y `HistoricalModule`. `AiopsDomainModule` importa `RcaModule` y **sigue** exponiendo `AgentOrchestratorStub`. `IncidentsModule` registra TopologyCorrelation + enrichment.

---

## Migración

**Path:** `ekumetrics-platform/apps/platform-api/prisma/migrations/20260905080000_wave2_aiops/migration.sql`

Crea enum `RcaFeedbackAction` (`CONFIRM` \| `REJECT` \| `SELECT_ALTERNATIVE` \| `ADD_NOTE`) y tablas:

| Tabla | Uso previsto |
|---|---|
| `AiopsAnomaly` | Persistencia de `AnomalyResult`; `entityId` lógico; `incidentId` opcional |
| `AiopsAnomalyPolicy` | Targeting + `config` JSON; FK opcional a `PlatformThresholds` |
| `IncidentEnrichment` | Snapshot 1:1 con `Incident` (columnas indexadas + JSON de evidencia) |
| `IncidentSignature` | Firma histórica `@@unique([tenantId, hash])` |
| `ResolutionRecord` | Resolución ligada a incidente / firma |
| `RcaFeedback` | Feedback de operador (enum Prisma uppercase) |
| `RcaScoringPolicy` | Pesos por `tenantId` + `environment` (`""` = default) |

Índices compuestos empiezan por `tenantId`. FKs a `Tenant` / `Incident` / `PlatformThresholds`.

```
cd ekumetrics-platform/apps/platform-api
npx prisma generate
npx prisma migrate deploy
```

No usar `migrate reset`. **Runtime Wave 2 no escribe estas tablas** (excepto lectura de `PlatformThresholds` y de `Policy` genérica para pesos RCA). El schema está listo para adaptadores Prisma.

---

## Algoritmos

Todos los motores de producto son deterministas. Salidas explicables: `score`, `confidence`, `algorithm`, `source`, `evidence[]`.

### Anomalía

Ventanas evaluadas (puntos acotados, no historial completo): `5m`, `15m`, `1h`, `24h`. El motor se queda con el mejor score por algoritmo.

| Algoritmo persistido | Detector | Emite cuando |
|---|---|---|
| `static_threshold` | Compara último valor con warn/crit de `PlatformThresholds` o override de política | ≥ warn (`above`) o ≤ warn (`below`) |
| `rolling_baseline` | Mediana, IQR, p05/p95 (Tukey; no asume normalidad) | Fuera de Q1/Q3 ± k·IQR, o quiebre de serie plana |
| `robust_zscore` | Iglewicz-Hoaglin: `0.6745 · (x − median) / MAD`. Score `min(1, \|z\|/6)` | `\|z\| ≥ 3.5` (configurable) |
| `ewma` | EWMA rápida/lenta + desplazamiento de medianas | Deriva o residuo ≥ `minScore` |
| `change_point` / `isolation_forest` / `seasonal_baseline` | Stubs | Siempre `[]` |

### RCA (`weighted_subscores_v1`, source `deterministic_rca`)

```
score =
  w_temporal   * temporalScore
+ w_topology   * topologyScore
+ w_anomaly    * anomalyScore
+ w_dependency * dependencyScore
+ w_historical * historicalScore
```

| Subscore | Qué mide | Sin señal |
|---|---|---|
| `temporalScore` | Candidato **antes** de fallos aguas abajo. Señal, no causalidad | `0.5` |
| `topologyScore` | Ancestro común, radio, camino, distancia | `0` si no hay camino |
| `anomalyScore` | `AnomalyResult.score` × confianza | `0` (no se fabrica; hoy el puerto es noop → 0) |
| `dependencyScore` | Fallo en dependencia > fallo en dependiente | `0.5` |
| `historicalScore` | Coincidencia del **mismo tenant** | **neutro `0.5`** (adaptador actual siempre neutro) |

`confidence` no es el score: combina score con cuántas señales independientes hay. Alertas solo cercanas en el tiempo **sin grafo** no obtienen score causal alto.

Hipótesis de ejemplo (generada por `explain.ts`):

> PostgreSQL PROD es el candidato principal de causa raíz porque: anomalía de latency score 0.94; la anomalía comenzó 34s antes que los errores de API Pagos; la topología muestra 2 entidades impactadas que dependen de esta dependencia; no se detectó anomalía aguas arriba. Score 0.85, confianza 0.91, algoritmo weighted_subscores_v1.

Disclaimer persistido en evidencia: *la precedencia temporal es una señal, no una prueba de causalidad.*

Enrichment **no** ejecuta este scorer. Construye candidatos desde `Incident.causeKey` + nodos de impacto (`deterministic_enrichment_v1`).

### Topología (extensión V2, no un motor nuevo)

1. V2 agrupa por sitio + ventana + `sharePath`.
2. Si hay `TopologyCorrelationService`, `merge()` llama `apply()` **después**.
3. `apply()` puede **unir clusters** si un ancestro común tiene confianza suficiente (supresión configurable).
4. `persist()` adjunta `members.blastRadius`, `members.suppression`, `members.topologyEvidence`. Recalcula solo el componente `topologyScore` del score V2 cuando hay pares de nodos.
5. Sin el servicio, V2 no cambia.

Blast radius: `originKey`, hops, `directDependents`, `indirectDependents`, `affectedServices`, `affectedApplications`. Impacto que decae con distancia (`0.75^(d-1)`). Confianza de relación: noisy-OR de fuentes (recolector + OTel + CMDB > inferida).

Supresión **no oculta síntomas**: siguen en `members.alerts` y `topologyEvidence`. Evita varios incidentes independientes de alta prioridad cuando la topología apunta a una causa aguas arriba.

### Enrichment (`deterministic_enrichment_v1`)

Timeline ordenada por `occurredAt` + `sequence`. Anomalías clasificadas desde nombres de alerta y `AgentEvent.signal` (`metric.anomaly`). Histórico del snapshot: otros `Incident` del mismo tenant con el mismo `causeKey` o `clusterKey` (`historical_cause_cluster`) — **no** es el Jaccard de Task 5.

Prioridad `weighted_priority_v1`: no usa solo `Incident.severity`. Bandas P1 ≥ 0.75, P2 ≥ 0.55, P3 ≥ 0.35, P4 resto.

### Histórico (`deterministic_jaccard_v1`)

Firma SHA-256 de características **estables** (tipos, servicio, eventos, anomalías, patrón de tipos topológicos, environment). `tenantId` no entra al hash; unicidad `(tenantId, hash)`. IDs, UUIDs, IPs, timestamps **fuera** del hash.

Similitud: Jaccard ponderado + cap de falso positivo (mismo servicio + distinta topología/eventos no puede acercarse a 1.0). `overridesCurrentEvidence` siempre `false`. Sin historial → `historicalScore = 0.5`, `matches = []`.

---

## Scoring configuration

### RCA

Defaults (`DEFAULT_RCA_WEIGHTS`, suman 1.0). Misma tabla Prisma `RcaScoringPolicy` (aún no leída por el loader):

| temporal | topology | anomaly | dependency | historical |
|---|---|---|---|---|
| 0.20 | 0.25 | 0.20 | 0.25 | 0.10 |

| Variable / fuente | Default |
|---|---|
| `AIOPS_RCA_WEIGHT_TEMPORAL` … `_HISTORICAL` | tabla de arriba |
| `AIOPS_RCA_HOPS` | 8 |
| `Policy` `kind` o `name` = `rca_scoring` | JSON `weights` + `hops` (lo que el loader **sí** lee hoy) |

El loader **no** consulta `prisma.rcaScoringPolicy`.

### Anomalía (`DEFAULT_ANOMALY_POLICY`)

| Campo | Default |
|---|---|
| `minScore` | 0.35 |
| `minSamples` | 8 (1 para estático) |
| `ewmaAlpha` / `ewmaLambda` | 0.3 / 0.05 |
| `robustZThreshold` | 3.5 |
| `rollingIqrK` | 1.5 |
| `staleMs` | 5 min |
| `enabledDetectors` | los cuatro implementados |

Targeting: `siteId`, `entityType`, `entityId`, `metricName`, `environment`. Gana la política más específica. Store de políticas: in-memory (tabla `AiopsAnomalyPolicy` sin adaptador).

### Supresión topológica

| Variable | Default | Efecto |
|---|---|---|
| `AIOPS_ROOT_CAUSE_SUPPRESSION_ENABLED` | `true` | Unión de clusters |
| `AIOPS_ROOT_CAUSE_SUPPRESSION_MIN_CONFIDENCE` | `0.55` | Confianza mínima hacia la causa |
| `AIOPS_ROOT_CAUSE_SUPPRESSION_MAX_HOPS` | `4` (`DEFAULT_CORRELATION_HOPS`) | Distancia máxima a la causa |
| `AIOPS_TOPOLOGY_CORRELATION_HOPS` | `8` (`TOPOLOGY_DEFAULT_HOPS`) | Blast radius / walks |

Si la supresión está off, V2 conserva los clusters; igual se calcula blast radius.

### Prioridad de incidente

| Factor | Peso |
|---|---|
| `severity` | 0.25 |
| `serviceCriticality` | 0.20 |
| `blastRadius` | 0.20 |
| `environment` | 0.15 |
| `affectedEntityCount` | 0.10 |
| `tenantPolicy` | 0.10 |

Override: `Policy` `kind=aiops.priority` o `name=incident-priority` (`boost`, `minLevel`, `weightOverrides`). Tests: `SEVERITY_ONLY_WEIGHTS`.

### Similitud histórica

| Dimensión | Peso |
|---|---|
| service (igualdad) | 0.25 |
| entityTypes (Jaccard) | 0.20 |
| eventTypes (Jaccard) | 0.20 |
| anomalyTypes (Jaccard) | 0.15 |
| topologyPattern (Jaccard de tokens) | 0.15 |
| environment (igualdad) | 0.05 |
| rootCause | bonus +0.08 (cap 1.0) si hay ResolutionRecord |

Cap: si `eventTypes` y `topologyPattern` son comparables y ambos Jaccard &lt; 0.2 → `similarity = min(score, 0.45)`.

---

## NATS / EventBus

Único catálogo: `src/messaging/subjects.ts`. Todo mensaje lleva `headers.tenantId` **y** `payload.tenantId`. Mismatch → `term`. El dominio no importa `@nats-io/*`.

| Constante | Subject | Stream | Durable / productor Wave 2 |
|---|---|---|---|
| `EVENTS_INGESTED` | `ekumetrics.events.ingested` | `EKU_EVENTS` | Consumer `aiops-anomaly-engine`. **Nadie en ingest HTTP publica** |
| `ANOMALIES_DETECTED` | `ekumetrics.anomalies.detected` | `EKU_ANOMALIES` (**nuevo**) | AnomalyEngine si el bus está up |
| `EVENTS_CORRELATED` | `ekumetrics.events.correlated` | `EKU_EVENTS` | TopologyCorrelation tras persistir incidente (payload aditivo: blastRadius, suppression, topologyEvidence) |
| `INCIDENTS_ENRICHMENT_REQUESTED` | `ekumetrics.incidents.enrichment.requested` | `EKU_INCIDENTS` | Publisher tras `POST /v1/incidents/correlate` (y `POST .../enrich`) |
| `INCIDENTS_ENRICHED` | `ekumetrics.incidents.enriched` | `EKU_INCIDENTS` | Worker `aiops-incident-enrichment` |
| `RCA_REQUESTED` | `ekumetrics.rca.requested` | `EKU_RCA` | Subscriber `aiops-rca-engine`. **Sin productor de producto** |
| `RCA_COMPLETED` | `ekumetrics.rca.completed` | `EKU_RCA` | RcaEngine tras `propose()` |

Idempotency típica: `{tenantId}:{subject}:{claveNatural}`.

```text
Alertmanager → CorrelationService.cluster (V2)
            → TopologyCorrelationService.apply
            → persist Incident
            → publish events.correlated
            → publish incidents.enrichment.requested   (HTTP no espera)
            → worker → IncidentEnrichment (in-memory)
            → publish incidents.enriched

POST /v1/ekms/events → AgentEvent          (sin events.ingested)
AnomalyWorker ──espera──► events.ingested  (listo; sin productor)
RcaEventSubscriber ──espera──► rca.requested (listo; sin productor)
```

Si NATS está degradado: correlate / list / get Wave 1 siguen; enrichment se omite con warning; anomalía persiste en el puerto y salta el publish (`aiops.anomaly.publish.skipped`).

---

## API

Contratos Wave 1 de list/get/correlate **conservados**. Campo opcional `enrichment` (`null` si el worker aún no corrió).

| Método | Ruta | Notas |
|---|---|---|
| GET | `/v1/incidents` | + `enrichment` opcional |
| GET | `/v1/incidents/:id` | + `enrichment` |
| GET | `/v1/incidents/:id/enrichment` | `{ incidentId, enrichment }` |
| POST | `/v1/incidents/correlate` | igual que Wave 1; además publica `enrichment.requested` |
| POST | `/v1/incidents/:id/enrich` | re-dispara el worker |
| POST | `/v1/incidents/:id/rca-feedback` | **Dos handlers:** enrichment espera `confirm`\|`reject`\|…; histórico espera `CONFIRM`\|`REJECT`\|… (ver limitaciones) |
| GET | `/v1/incidents/:id/rca-feedback` | Listado histórico append-only |
| GET | `/v1/incidents/:id/historical` | `{ contribution, resolution, feedback }` |
| POST | `/v1/incidents/:id/historical/lookup` | Indexa firma + lookup (IDs volátiles ignorados) |
| GET | `/v1/incidents/:id/resolution` | `ResolutionRecord` (404 si no hay) |
| POST | `/v1/ekms/events` | **Sin cambio** de path ni de publicación al bus |

`POST /v1/ekms/events` no corre detección ni RCA. El portal envía feedback en **minúsculas** al panel de enrichment.

---

## Métricas OpenTelemetry / Prometheus

Constantes: `AiopsMetricNames` en `src/aiops/contracts/metrics.ts`. Wave 1 sigue emitiendo `aiops_correlation_*`.

| Serie | Origen |
|---|---|
| `aiops_anomalies_detected_total` | AnomalyEngine |
| `aiops_anomaly_detection_duration_seconds` | AnomalyEngine |
| `aiops_rca_requests_total` | RcaEngine |
| `aiops_rca_completed_total{outcome}` | RcaEngine |
| `aiops_rca_duration_seconds` | RcaEngine |
| `aiops_rca_confidence` | RcaEngine (candidato principal) |
| `aiops_topology_correlations_total` | TopologyCorrelation |
| `aiops_root_cause_suppressions_total` | TopologyCorrelation |
| `aiops_incident_enrichment_duration_seconds` | Enrichment |
| `aiops_incident_enrichments_total{outcome}` | Enrichment (extra al contrato) |
| `aiops_historical_lookups_total{outcome}` | Histórico |
| `aiops_rca_feedback_total{action}` | Histórico |

---

## Tests

Desde `ekumetrics-platform/apps/platform-api`:

```bash
npx jest src/aiops/contracts/wave2-contracts.spec.ts \
  src/aiops/anomaly \
  src/aiops/rca \
  src/aiops/topology-correlation \
  src/aiops/enrichment \
  src/aiops/historical \
  src/aiops/correlation.service.spec.ts \
  src/aiops/correlation-score.spec.ts \
  src/aiops/stubs/aiops-stubs.spec.ts \
  src/aiops/types/rca-domain.spec.ts \
  src/messaging/event-bus.spec.ts \
  --runInBand
```

Portal:

```bash
# apps/portal-web
npx ng test --include='**/incident-enrichment*.spec.ts' --include='**/incidents-page.spec.ts'
```

Cobertura por workstream (lo que los specs afirman):

| Área | Specs | Cubre |
|---|---|---|
| Contratos | `wave2-contracts.spec` | Subjects/métricas vs catálogo |
| Anomalía | `anomaly.engine.spec`, `metric-window.store.spec` | Spike, deriva, línea plana, ruido, tenant, stubs vacíos, payload con `tenantId` |
| RCA | `engine`, `scorer`, `scoring-policy`, `subscriber`, `metrics` | Ranking dependencia, temporal ≠ causalidad, historial neutro, pesos, EventBus, tenant |
| Topología | `topology-correlation.*.spec`, `correlation.service.spec` | Ancestro, blast radius, supresión, falso positivo temporal, tenant, publish |
| Enrichment | service, worker, controller, priority, timeline, repository, metrics | Timeline, P1 vs severity-only, correlate no bloquea, tenant |
| Histórico | signature, similarity, service, controller, repository, metrics | Hash estable, Jaccard, cap FP, feedback UPPERCASE, 404 cross-tenant |
| Stubs | `aiops-stubs.spec` | Orchestrator stub / RcaAgent SKIPPED (Wave 1 intacto) |

No hay benches (`*bench*`) en `src/aiops`.

---

## Known limitations

1. **Prisma de resultado no está cableado.** Tablas Wave 2 existen; anomalía, enrichment, firmas, resoluciones y `RcaFeedback` viven en Maps in-memory (se pierden al reiniciar / no se comparten entre réplicas). `StaticThreshold` sí lee `PlatformThresholds` por Prisma.
2. **Ingest HTTP no publica `events.ingested`.** AnomalyEngine no corre en el path de producto hasta que ingest (u otro productor) publique.
3. **Nadie publica `rca.requested` desde correlate.** RcaEngine y el subscriber están listos; el ranking `weighted_subscores_v1` no entra al snapshot de enrichment por el bus.
4. **Puertos RCA no unidos a Tasks 1 y 5.** `NoopAnomalyEvidenceAdapter` y `NeutralHistoricalEvidenceAdapter`. `HistoricalService` exporta `HISTORICAL_EVIDENCE`; RcaModule inyecta otro token/adaptador.
5. **Pesos RCA:** loader usa tabla `Policy`; modelo `RcaScoringPolicy` sin lecturas en runtime.
6. **Enrichment no consume AnomalyEngine ni RcaEngine.** Anomalías = heurística de alertas/`metric.anomaly`. RCA de UI = caché `Incident.cause*` + alternativas de impacto.
7. **Histórico de enrichment ≠ Jaccard.** El panel puede mostrar matches por `causeKey`/`clusterKey` aunque `HistoricalService` esté vacío.
8. **Dos vocabularios de feedback** en la misma ruta HTTP (`confirm` vs `CONFIRM`). El portal usa minúsculas (store de enrichment). La fundación histórica + enum Prisma usan UPPERCASE. No hay un único store durable.
9. **Buffer de series de anomalía** en proceso (24 h / 1440 puntos / 5000 series), no compartido entre réplicas.
10. **Detectores avanzados** (change-point, Isolation Forest, seasonal) son stubs.
11. **`RootCauseCandidate` sigue sin tabla.** `Incident.causeKey` es caché de correlación; RCA no escribe `Incident.status`.
12. **Embeddings / pgvector no se usan** para incidentes (RAG de EkuAssistant intacto y aparte).
13. **`AgentOrchestrator` no se implementó.** Stub Wave 1. `RcaAgent` (AIOps Agent) sigue `SKIPPED`.
14. **CanonicalEvent, IncidentCandidate, remediación, ITSM:** fuera de Wave 2.
15. **Correlación sigue on-demand** (`POST /v1/incidents/correlate`), no continua.

Las notas de Task 4/5 que decían «no existe modelo Prisma» quedaron **obsoletas** tras el workstream de contratos: el schema existe; falta el adaptador.

---

## Definition of Done — Wave 2

Criterios del spec Wave 2, marcados según código/docs actuales (no según intención).

| # | Criterio | Estado |
|---|---|---|
| 1 | Detectar anomalías sin LLM | **Cumplido a nivel motor.** Cuatro detectores + worker. El path HTTP de ingest **aún no alimenta** el worker. |
| 2 | Correlacionar anomalías con incidentes | **Parcial.** Enrichment adjunta anomalías heurísticas al snapshot. AnomalyEngine no setea `incidentId`. RCA no lee anomalías (puerto noop). |
| 3 | Candidatos RCA aguas arriba (topología) | **Cumplido** en TopologyCorrelation (`getCommonAncestor` / cover) y en RcaEngine cuando se invoca. Correlate persiste `causeKey` topológico. |
| 4 | Blast radius | **Cumplido.** `members.blastRadius` + panel. Sin segundo grafo. |
| 5 | Suprimir ruido de síntomas aguas abajo | **Cumplido** (unión de clusters configurable; evidencia retenida). |
| 6 | Rankear candidatos RCA | **Cumplido en RcaEngine** (`weighted_subscores_v1`). En producto, el panel rankea la caché de correlación, no el scorer, hasta que exista productor `rca.requested`. |
| 7 | Explicar RCA con evidencia | **Cumplido en RcaEngine** (hipótesis + `evidence[]` + disclaimer temporal). UI muestra evidencia de enrichment. |
| 8 | Enriquecer incidentes (timeline / topología / anomalías) | **Cumplido** de forma asíncrona. Persistencia in-memory. Contrato HTTP Wave 1 intacto. |
| 9 | Fundación de feedback RCA del operador | **Parcial.** APIs + stores in-memory. Tablas Prisma sin write path. Vocabularios duplicados. |
| 10 | Evidencia histórica cuando hay datos | **Parcial.** Jaccard + NEUTRAL sin historia: implementado. RcaEngine no lo consulta. Enrichment usa otro matching (`Incident.causeKey`/`clusterKey`) cuando hay incidentes previos. |
| 11 | Conservar comportamiento de producto | **Cumplido.** Ingest, correlate, grafo, `/incidentes`, `/investigacion`, EkuAssistant/Holmes paralelos. Enrichment opcional / empty state. |
| 12 | Funcional sin Holmes/LLM | **Cumplido.** Ningún motor Wave 2 llama Holmes/Ollama. Si el LLM cae, correlación, topología, RCA determinista y enrichment siguen. |

---

## Wave 3 recomendado (siguiente; no ahora)

Wave 2 cierra **motores**. Wave 3 debe abrir **orquestación de AIOps Agents**, no reescribir AnomalyEngine / RcaEngine / Correlation V2.

1. **`AgentOrchestrator` (siguiente entregable).** Sustituir `AgentOrchestratorStub`. Dueño de selección, presupuesto (`maxAgents`, timeouts), estados `PENDING`…`TIMEOUT`, y Evidence Store (`AgentFinding` / `AiopsInvestigation` ya existen). **Sin lógica de dominio** (no scoring RCA, no detectores, no blast radius). No usar Holmes como orquestador.
2. **Disparo desde incidente enriquecido.** Tras correlate (o desde `incidents.enriched`), publicar `rca.requested` y/o `aiops.investigation.requested`. El orquestador elige agentes; RcaEngine ya es el backend determinista de RCA — `RcaAgent` debe delegar en `RcaEngine.propose`, no en un LLM.
3. **AIOps Agents MVP (tools acotadas):** Metrics, Logs, Kubernetes, Topology, Synthesis. Selección por `entityType` / anomalías / blast radius. Metrics/Topology/RCA **cero LLM**. Kubernetes puede usar Holmes **solo como tool layer**. Synthesis es el único sitio donde un LLM aporta resumen; si cae, el incidente + RCA + findings crudos siguen siendo el producto.
4. **Cablear Prisma** de las tablas Wave 2 (anomalía, enrichment 1:1, firma, resolución, feedback, `RcaScoringPolicy`) **antes** de depender del histórico en réplicas. Unificar feedback operador (un vocabulario, un store).
5. **Cerrar el bus de producto (sin CanonicalEvent todavía):** ingest → `events.ingested`; AnomalyEngine → correlación/RCA vía `AnomalyEvidencePort`; `HistoricalService` → puerto RCA. No hace falta un segundo grafo ni un vector DB de incidentes.
6. **Fuera de Wave 3 inmediato:** remediación autónoma, ITSM, CanonicalEvent completo, Isolation Forest de verdad, embeddings de incidentes, segundo recolector.

Pipeline objetivo (recordatorio; Holmes no está en el centro):

```text
Ekumetrics Agent → ingest / OTLP
  → EventBus
  → Correlation V2 + TopologyCorrelation + AnomalyEngine
  → Incident + IncidentEnrichment
  → RcaEngine (determinista)
  → AgentOrchestrator → Metrics / Logs / Kubernetes / Topology → Synthesis
  → ITSM / remediación aprobada (más tarde)
```

---

## STOP

Wave 2 cerrada a nivel de **motores deterministas + contratos + UI de enrichment**. **No implementar `AgentOrchestrator` en este cierre.** Wave 1 no se reescribe.
