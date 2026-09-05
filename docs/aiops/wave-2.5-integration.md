# Wave 2.5 AIOps — product pipeline integration and durability

**Status:** implemented in `platform-api` (deterministic path). No `AgentOrchestrator`. No Holmes/Ollama/cloud LLM.  
**Date:** 2026-09-05  
**Code:** `ekumetrics-platform`  
**Nomenclature:** **Ekumetrics Agent** = collector (`ekumetrics-agent/`). **AIOps Agent** = investigation agent inside the platform (`RcaAgent`, `MetricsAgent`, …). HolmesGPT is not the AIOps architecture.

Wave 2 delivered engines (AnomalyEngine, RcaEngine, TopologyCorrelation, enrichment, historical matching) that were largely off the product path and in-memory. Wave 2.5 **wires those engines into the live pipeline** and makes operator-visible state **durable and replica-safe**.

Wave 1 APIs stay backwards compatible: `POST /v1/ekms/events`, `POST /v1/incidents/correlate`, incident list/detail. `AgentOrchestratorStub` is unchanged.

---

## Runtime pipeline

```text
Ekumetrics Agent
  → POST /v1/ekms/events
  → validate + persist AgentEvent (same Serializable transaction as outbox enqueue)
  → HTTP ACK
  → EventOutbox flush → ekumetrics.events.ingested
  → AnomalyWorker → AnomalyEngine → AiopsAnomaly (PostgreSQL)
  → ekumetrics.anomalies.detected
  → CorrelationPipelineSubscriber → DeferredCorrelationPipelineConsumer (no-op)

POST /v1/incidents/correlate (manual, preserved)
  → Incident (+ TopologyCorrelation)
  → ekumetrics.incidents.enrichment.requested
  → IncidentEnrichmentWorker
  → IncidentEnrichment snapshot (correlation, topology, blast radius, persisted anomalies, historical, timeline)
  → ekumetrics.rca.requested (outbox when Prisma is available)
  → RcaEventSubscriber → RcaEngine.propose() (deterministic)
       AnomalyEvidencePort → AiopsAnomaly repository
       HistoricalEvidencePort → HistoricalService (fail-open → 0.5)
  → ekumetrics.rca.completed
  → IncidentRcaCompletedSubscriber → update IncidentEnrichment
  → GET /v1/incidents/:id (any replica)

Operator feedback
  → POST /v1/incidents/:id/rca-feedback
  → canonical action CONFIRM|REJECT|SELECT_ALTERNATIVE|ADD_NOTE
  → RcaFeedback + ResolutionRecord (PostgreSQL)
  → enrichment operatorFeedback (if a snapshot exists)
```

HTTP ingest **does not wait** for anomaly detection. Correlate **does not wait** for enrichment or RCA. If RCA fails, the Incident remains. If enrichment fails, GET incident still works.

```mermaid
sequenceDiagram
  participant Agent as Ekumetrics Agent
  participant API as platform-api replica
  participant PG as PostgreSQL
  participant Bus as EventBus (NATS / memory)
  participant Anom as AnomalyWorker
  participant Enr as EnrichmentWorker
  participant Rca as RcaEventSubscriber
  participant UI as portal-web /incidentes

  Agent->>API: POST /v1/ekms/events
  API->>PG: AgentEvent + AiopsEventOutbox (same tx)
  API-->>Agent: HTTP ACK
  API->>Bus: flush ekumetrics.events.ingested
  Bus->>Anom: queue group aiops-anomaly-engine
  Anom->>PG: upsert AiopsAnomaly
  Anom->>Bus: ekumetrics.anomalies.detected
  Note over Bus: CorrelationPipelineSubscriber acks; no auto-correlate

  UI->>API: POST /v1/incidents/correlate
  API->>PG: Incident
  API->>Bus: ekumetrics.incidents.enrichment.requested
  API-->>UI: correlate result (Wave 1 contract)
  Bus->>Enr: enrich snapshot
  Enr->>PG: IncidentEnrichment
  Enr->>Bus: ekumetrics.rca.requested
  Bus->>Rca: RcaEngine.propose (no LLM)
  Rca->>PG: read AiopsAnomaly + signatures/resolutions
  Rca->>Bus: ekumetrics.rca.completed
  Bus->>Enr: applyRcaCompleted
  Enr->>PG: IncidentEnrichment.snapshot
  UI->>API: GET /v1/incidents/:id (any replica)
  API->>PG: Incident + IncidentEnrichment
  API-->>UI: deterministic RCA + AI Investigation placeholder
```

---

## NATS / EventBus producer–consumer matrix

| Subject | Producer | Consumer | Idempotency key |
|---|---|---|---|
| `ekumetrics.events.ingested` | `IngestService` via `EventOutboxService` | `AnomalyWorker` (`aiops-anomaly-engine`, queue group) | `{tenantId}:events.ingested:{agentEventId}` |
| `ekumetrics.anomalies.detected` | `AnomalyEngine` | `CorrelationPipelineSubscriber` (deferred) | engine-generated per series |
| `ekumetrics.incidents.enrichment.requested` | `IncidentEnrichmentPublisher` after correlate / refresh | `IncidentEnrichmentWorker` | `{tenantId}:incidents.enrichment.requested:{incidentId}` |
| `ekumetrics.incidents.enriched` | Enrichment worker | (observability / Wave 3) | `{tenantId}:incidents.enriched:{incidentId}:{score}` |
| `ekumetrics.rca.requested` | Enrichment worker via outbox or bus | `RcaEventSubscriber` (`aiops-rca-engine`) | `{tenantId}:rca.requested:{incidentId}` |
| `ekumetrics.rca.completed` | `RcaEventSubscriber` | `IncidentRcaCompletedSubscriber` | `{tenantId}:rca.completed:{incidentId}:{correlationId}` |

`headers.tenantId` and `payload.tenantId` must match. Mismatch is `term` (invalid), not retry.

NATS is **at-least-once**. Consumers are idempotent via natural keys (anomaly id, enrichment 1:1 `incidentId`, feedback insert is append-only, RCA snapshot replace). Do not assume exactly-once delivery.

---

## Prisma repositories (production wiring)

Tables already existed from Wave 2. Wave 2.5 adds `IncidentEnrichment.snapshot`, `IncidentSignature.incidentIds`, and `AiopsEventOutbox`. No duplicate tables.

| Domain | Port | Production adapter | In-memory |
|---|---|---|---|
| `AiopsAnomaly` | `AnomalyRepository` | `PrismaAnomalyRepository` | tests |
| `AiopsAnomalyPolicy` | `AnomalyPolicyRepository` | `PrismaAnomalyPolicyRepository` | tests |
| `IncidentEnrichment` | `IncidentEnrichmentRepository` | `PrismaIncidentEnrichmentRepository` (full snapshot JSON) | tests |
| Signature / resolution / feedback | `HistoricalRepository` | `PrismaHistoricalRepository` | tests |
| `RcaScoringPolicy` | `RcaScoringPolicyLoader` | Prisma `RcaScoringPolicy` | n/a |
| Outbox | `EventOutboxService` | `AiopsEventOutbox` | n/a |

All queries take `tenantId`. Cross-tenant reads return empty/null or `TenantScopeError`.

**Kubernetes:** Replica A can ingest, replica B can run RCA, replica C can serve GET. Persisted rows are the source of truth. Outbox flush uses `updateMany` pending→publishing so only one replica publishes a given row.

---

## Task notes

### Task 1 — Ingest → EventBus

`IngestService` is unchanged as the HTTP entrypoint. After `AgentEvent` insert (`createManyAndReturn`, `skipDuplicates: true`), it enqueues `ekumetrics.events.ingested` **in the same Serializable transaction**. HTTP then returns; `void outbox.flush()` is fire-and-forget.

Payload includes `tenantId`, `agentEventId`, entity (`entityId` / `assetKey` / `entityType`), `signal`, timestamps, `value` / `metricName` when present, labels/attributes/tags.

If EventBus is down: AgentEvent remains committed. Outbox stays `pending`, backoff up to 8 attempts, metrics `aiops_events_ingested_publish_failures_total`, structured logs (no icons). Re-enqueue of the same `{tenantId, idempotencyKey}` is `skipDuplicates`.

### Task 2 — Prisma durability

Production modules inject Prisma adapters. Maps are not used for product behavior. `aiops_anomaly_persistence_total` increments when AnomalyEngine saves hits.

### Task 3 — RCA pipeline

After a successful enrichment pass, the worker publishes `rca.requested`. `RcaEngine` remains deterministic (`weighted_subscores_v1`). Production evidence:

- `RepositoryAnomalyEvidenceAdapter` (not Noop)
- `HistoricalServiceEvidenceAdapter` (not Neutral). HistoricalService failure → score `0.5`, `available: false`

Noop/Neutral adapters remain **exported for unit tests only**.

### Task 4 — Enrichment unification

One snapshot consumes correlation members, graph blast radius, persisted `AiopsAnomaly` rows (heuristic classify is fallback), historical matches, timeline, and — once `rca.completed` arrives — RcaEngine candidates.

There is **no second RCA algorithm** inside enrichment. Until `rca.completed`, UI may show `rcaMode: correlation_fallback` from `Incident.causeKey`. After RCA: `rcaMode: deterministic_engine`. `aiInvestigationStatus` is always `not_executed` in this wave.

`aiops_enrichment_updates_total` / `aiops_rca_results_persisted_total` are emitted on save.

### Task 5 — Feedback and scoring policy

Canonical domain/API/DB enum: `CONFIRM`, `REJECT`, `SELECT_ALTERNATIVE`, `ADD_NOTE`. HTTP still accepts Wave 2 lowercase aliases via `parseRcaFeedbackAction`; they are never stored as a second vocabulary. Metric: `aiops_feedback_total` (and existing `aiops_rca_feedback_total`).

`POST /v1/incidents/:id/rca-feedback` on `IncidentsController` persists `RcaFeedback` through `HistoricalService` and patches enrichment when a snapshot exists. `HistoricalController` keeps the same path for the historical API used by tests (canonical enum).

**RcaScoringPolicy loader priority:**

1. `RcaScoringPolicy` for `tenantId` + environment  
2. Tenant default row (`environment = ""`)  
3. Generic `Policy` where `kind` or `name` is `rca_scoring` (**Wave 2 fallback**, documented for backwards compatibility)  
4. Environment variables `AIOPS_RCA_WEIGHT_*` / `AIOPS_RCA_HOPS`  
5. Application defaults (temporal 0.20, topology 0.25, anomaly 0.20, dependency 0.25, historical 0.10)

Do not add a third persistence mechanism for weights.

### Correlation (Wave 3 interface)

`POST /v1/incidents/correlate` is unchanged and remains the product path. Auto-correlation on every ingested event would change operator-visible incident creation, so it is **not** enabled.

`CorrelationPipelineConsumer` + `CorrelationPipelineSubscriber` listen to `ekumetrics.anomalies.detected` and call a **no-op** `DeferredCorrelationPipelineConsumer`. Wave 3 can replace the consumer with a call into `CorrelationService` without changing subjects.

Target architecture: AgentEvent → EventBus → Anomaly → Correlation → Incident → Enrichment → RCA.

---

## Failure behavior

| Failure | Product behavior |
|---|---|
| AnomalyEngine / worker error | Incident/correlation continue; NAK for retry |
| RcaEngine error | Incident exists; enrichment may stay on correlation fallback |
| HistoricalService error | RCA runs with historicalScore 0.5 (unknown, not invented recurrence) |
| Enrichment error | Incident GET remains; empty enrichment panel |
| NATS / EventBus down | HTTP ingest and correlate still persist; outbox retries; enrichment request is skipped with a warning |
| Duplicate delivery | Upsert / replace snapshot / append-only feedback; bus-level idempotency keys |

---

## Idempotency and multi-replica

- Outbox unique `(tenantId, idempotencyKey)` + claim `updateMany` (`pending` → `publishing`).
- Anomaly id is deterministic (`tenantId|entity|metric|algorithm|window|timestamp`).
- Enrichment is 1:1 on `incidentId` (tenant-checked).
- RCA completed **replaces** `rootCauseCandidates` rather than appending.
- Queue groups so multiple `platform-api` replicas share consumers.

**Not replica-shared:** `MetricWindowStore` (in-process 24h series buffer). Anomaly **results** are durable; detection quality for a series still depends on samples observed by the replica that handles that message. Documented as a remaining limitation (no new datastore in this wave).

---

## Observability

| Metric | Meaning |
|---|---|
| `aiops_events_ingested_published_total` | Outbox publish OK |
| `aiops_events_ingested_publish_failures_total` | Outbox publish failed / bus unavailable |
| `aiops_anomaly_persistence_total` | Anomaly rows saved |
| `aiops_rca_requested_published_total` | `rca.requested` published |
| `aiops_rca_requested_publish_failures_total` | `rca.requested` publish failed |
| `aiops_rca_results_persisted_total` | RcaEngine snapshot written into enrichment |
| `aiops_enrichment_updates_total` | Enrichment saves |
| `aiops_feedback_total` | Canonical operator feedback |

Trace context: EventBus headers (`correlationId`, `causationId`, `producedBy`) are preserved from ingest → RCA completed where the bus carries them. Ingest `traceId` becomes `correlationId` on `events.ingested`.

---

## UI (`/incidentes`)

No redesign. The existing enrichment panel shows root cause, confidence, algorithm, mode (deterministic engine vs correlation fallback), evidence, anomalies, blast radius, timeline, historical matches, RCA feedback (canonical enum, Spanish labels). The Wave 3 investigation panel (status, AIOps Agents, synthesis, Investigar/Reintentar) replaced the placeholder; see `docs/aiops/wave-3-investigation.md`. Holmes is not the orchestrator.

Browser automation was not available in this wave; portal Jest specs cover list empty-state and enrichment rendering.

---

## Remaining limitations

1. **Auto-correlation is deferred.** Manual `POST /v1/incidents/correlate` only.
2. **MetricWindowStore is in-process.** Multi-replica detection baselines are not shared (results are).
3. **Advanced anomaly detectors** remain stubs (change-point, isolation forest, seasonal).
4. **`AgentOrchestrator` (Wave 2.5):** stub Wave 1. **Closed in Wave 3** (`AgentOrchestratorService`; see `docs/aiops/wave-3-investigation.md`). The Wave 1 stub remains for unit tests.
5. **Generic `Policy` fallback** for RCA weights still exists for tenants that never received a `RcaScoringPolicy` row.
6. **Duplicate HTTP POST** ` /v1/incidents/:id/rca-feedback` exists on `IncidentsController` (product + enrichment patch) and `HistoricalController` (historical API / unit tests). Both persist canonical enum via `HistoricalService`.
7. **No LLM / Holmes / Ollama** on this path by design.
8. **CanonicalEvent, remediación, ITSM** remain out of scope.

---

## Generic Policy fallback (RCA weights)

Wave 2 stored weights in `Policy` (`kind`/`name` = `rca_scoring`). Wave 2.5 treats `RcaScoringPolicy` as canonical. If no structured row exists, `RcaScoringPolicyLoader.readLegacyPolicy` reads that generic Policy payload (`weights` + optional `hops`). New tenants should write `RcaScoringPolicy`; do not add new writers to generic Policy for RCA weights.

---

## Wave 2.5 architecture review (Definition of Done)

| # | Criterion | Result |
|---|---|---|
| 1 | Real AgentEvent ingestion feeds AnomalyEngine | **Pass.** Outbox publishes `events.ingested`; worker consumes. |
| 2 | Anomalies are durable | **Pass.** `PrismaAnomalyRepository` / `AiopsAnomaly`. |
| 3 | Real incidents automatically feed RcaEngine | **Pass.** Enrichment worker publishes `rca.requested` after enrich. Correlate still triggers enrichment.requested. |
| 4 | RCA uses real anomaly evidence | **Pass.** `RepositoryAnomalyEvidenceAdapter`. |
| 5 | RCA uses real historical evidence | **Pass.** `HistoricalServiceEvidenceAdapter`; 0.5 only when no evidence / lookup failure. |
| 6 | RCA results reach IncidentEnrichment | **Pass.** `IncidentRcaCompletedSubscriber` + `applyRcaCompleted`. |
| 7 | Enrichment is durable | **Pass.** Prisma snapshot JSON. |
| 8 | Historical signatures/resolutions are durable | **Pass.** `PrismaHistoricalRepository`. |
| 9 | Operator feedback is durable and unified | **Pass.** Canonical enum + Prisma `RcaFeedback`. Lowercase aliases mapped at the edge. |
| 10 | RCA policy has one canonical runtime source | **Pass.** `RcaScoringPolicy` first; generic Policy documented fallback. |
| 11 | Product works across multiple platform-api replicas | **Pass** for persisted state (outbox claim, Prisma). Window store still in-process (limitation). |
| 12 | Deterministic pipeline works without Holmes/Ollama/cloud LLM | **Pass.** |
| 13 | Existing APIs remain backwards compatible | **Pass.** Ingest, correlate, incident GET, lowercase feedback aliases. |
| 14 | Automated integration tests validate the deterministic path | **Pass** (Jest in `platform-api` / portal-web). |
| — | `AgentOrchestrator` **not** implemented | **Pass.** Stub only. |

**STOP.** Do not implement `AgentOrchestrator` in this wave.
