# Wave 2 Task 4 — Incident Enrichment

**Estado:** implementado (capa de enriquecimiento asíncrona).  
**Fecha:** 2026-09-05  
**No toca:** Prisma schema, AgentOrchestrator, Wave 1 correlation/topology/EventBus port.  
**Nomenclatura:** Ekumetrics Agent = recolector. AIOps Agents = investigadores (esta tarea no los implementa).

El enriquecimiento **no corre en la ingesta HTTP**. `POST /v1/ekms/events` no cambia. Tras `POST /v1/incidents/correlate`, la API publica `ekumetrics.incidents.enrichment.requested` y un worker EventBus construye `IncidentEnrichment`.

No existe en el plan original de Task 4, pero Wave 2 posterior añadió modelo Prisma `IncidentEnrichment` (JSON flexible + campos indexados `tenantId`, `rcaConfidence`, `primaryRootCause`). Producción usa `PrismaIncidentEnrichmentRepository`; tests usan el store in-memory.

---

## Files changed

### Backend (`ekumetrics-platform/apps/platform-api`)

| Path | Rol |
|---|---|
| `src/aiops/enrichment/incident-enrichment.types.ts` | Payload `IncidentEnrichment` explicable |
| `src/aiops/enrichment/incident-timeline.ts` | Orden `occurredAt` + `sequence` |
| `src/aiops/enrichment/incident-priority.calculator.ts` | Prioridad extensible (no solo severidad) |
| `src/aiops/enrichment/incident-enrichment.repository.ts` | Puerto + store in-memory, `tenantId` obligatorio |
| `src/aiops/enrichment/incident-enrichment.service.ts` | Motor determinista (grafo, miembros, historial, cambios) |
| `src/aiops/enrichment/incident-enrichment.publisher.ts` | Publica `enrichment.requested` (no bloquea correlate si el bus cae) |
| `src/aiops/enrichment/incident-enrichment.worker.ts` | Consumer → enrich → `incidents.enriched` |
| `src/aiops/enrichment/incident-enrichment.metrics.ts` | `aiops_incident_enrichment_duration_seconds` |
| `src/aiops/enrichment/prisma-incident-enrichment.repository.ts` | Persistencia Prisma `IncidentEnrichment` |
| `src/aiops/enrichment/incident-rca-completed.subscriber.ts` | Consume `ekumetrics.rca.completed` |
| `src/aiops/incidents.module.ts` | Providers de enrichment |
| `src/messaging/subjects.ts` | Subjects Wave 2 de incidentes |

### UI (`apps/portal-web`) — extensión mínima, mismo Cytoscape

| Path | Rol |
|---|---|
| `src/app/pages/incidents/incident-enrichment-panel.*` | Panel: anomalías, RCA, evidencia, radio, timeline, feedback reactivo |
| `src/app/pages/incidents/incident-enrichment.view.ts` | Helpers de empty state |
| `src/app/pages/incidents/incidents-page.*` | `/incidentes` |
| `src/app/pages/investigacion/investigacion-page.*` | `/investigacion` |

### Docs

`docs/aiops/wave-2-task-4-enrichment.md` (este archivo)

---

## Enrichment payload

```ts
IncidentEnrichment = {
  tenantId, incidentId,
  schemaVersion: 1,
  algorithm: 'deterministic_enrichment_v1',
  source: 'aiops.enrichment',
  score, confidence, evidence[],          // explicable
  computedPriority,                       // ver algoritmo abajo
  affectedEntities, affectedServices,
  blastRadius, topologyEvidence,
  anomalies,
  rootCauseCandidates, primaryRootCause, rcaConfidence,
  correlationEvidence,
  timeline,                               // ordered, sequence 1..n
  recentChanges, historicalMatches,
  operatorFeedback, enrichedAt
}
```

Cada salida lleva **score, confidence, algorithm, source**.  
`primaryRootCause` reutiliza `Incident.causeKey` / `confidence` (caché Wave 1). Alternativas = nodos de impacto. No hay RcaAgent ni orquestador.

Timeline de ejemplo (orden por reloj):

```
10:31:02 DB latency anomaly
10:31:15 connection pool saturation
10:31:36 API latency
10:31:41 HTTP 5xx
10:31:55 pod timeout
```

---

## EventBus

Reuse Wave 1 naming + `tenantId` en header y payload. Stream existente `EKU_INCIDENTS` (`ekumetrics.incidents.>`).

| Constante | Subject |
|---|---|
| `INCIDENTS_ENRICHMENT_REQUESTED` | `ekumetrics.incidents.enrichment.requested` |
| `INCIDENTS_ENRICHED` | `ekumetrics.incidents.enriched` |

Consumer durable: `aiops-incident-enrichment`.  
Correlate HTTP **no espera** al worker. Si NATS está degradado, se registra warning y el incidente Wave 1 se devuelve igual.

---

## OTel / métricas

Serie Prometheus (mismo patrón que correlación):

- `aiops_incident_enrichment_duration_seconds` (histogram)
- `aiops_incident_enrichments_total{outcome=ok\|missing\|error}`

---

## Priority algorithm

`IncidentPriorityCalculator` (`weighted_priority_v1`). **No** usa solo `Incident.severity`.

Factores (pesos default, normalizados a 1):

| Factor | Peso | Cómo |
|---|---|---|
| `severity` | 0.25 | critical=1, error=0.8, warning=0.45, info=0.15 |
| `serviceCriticality` | 0.20 | `kind` de servicios/DB/pods (override por política) |
| `blastRadius` | 0.20 | `min(1, entityCount / 10)` |
| `environment` | 0.15 | prod=1, staging=0.45, dev=0.15 (AgentEvent.environment) |
| `affectedEntityCount` | 0.10 | `min(1, n / 8)` |
| `tenantPolicy` | 0.10 | `Policy` `kind=aiops.priority` o `name=incident-priority` (`boost`, `minLevel`, `weightOverrides`) |

Bandas: **P1** ≥ 0.75 · **P2** ≥ 0.55 · **P3** ≥ 0.35 · **P4** resto.  
Extensible: `withContributor()`. Modo test `SEVERITY_ONLY_WEIGHTS` para contrastar vs blast-radius-aware.

---

## API

Contrato Wave 1 de list/get/correlate **conservado**. Campo opcional `enrichment` (null si el worker aún no corrió).

| Método | Ruta | Notas |
|---|---|---|
| GET | `/v1/incidents` | + `enrichment` opcional |
| GET | `/v1/incidents/:id` | + `enrichment` |
| GET | `/v1/incidents/:id/enrichment` | `{ incidentId, enrichment }` |
| POST | `/v1/incidents/correlate` | igual que Wave 1; además publica requested |
| POST | `/v1/incidents/:id/enrich` | re-dispara el worker |
| POST | `/v1/incidents/:id/rca-feedback` | stub Task 5: `confirm` \| `reject` \| `select_alternative` \| `add_note` |

Feedback RCA se guarda en el store in-module (no tabla histórica). UI hace feature-detect (404 oculta el formulario).

---

## UI

Sin segundo frontend de topología. Empty states si no hay Wave 2. Formularios reactive (`formControlName`), sin `ngModel`. El proyecto no usa PrimeNG; inputs nativos como el resto del portal.

---

## Tests

- enrichment del incidente + aislamiento tenant
- orden de timeline
- priority severity-only vs blast-radius-aware
- worker EventBus
- controller: list Wave 1 + correlate no bloquea
- `correlation.service.spec` existente (no se reescribe el motor V1)
- portal: empty state + panel con datos

---

## Limitaciones

- Store Prisma `IncidentEnrichment` (snapshot JSON + campos indexados). El in-memory queda para tests.
- Sin CanonicalEvent obligatorio: anomalías también desde AnomalyRepository si está cableado.
- Feedback de operador se reenvía a HistoricalService cuando existe (Task 5).
