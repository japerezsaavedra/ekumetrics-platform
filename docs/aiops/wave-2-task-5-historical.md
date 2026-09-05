# Wave 2 — TASK 5: Historical Intelligence Foundation

Fundación de matching histórico **determinista** para AIOps. No usa embeddings, no introduce un vector DB y no sustituye la evidencia actual del incidente.

**Estado:** implementado en `platform-api` (`src/aiops/historical/`). Sin modelos Prisma (el schema central no se tocó). Persistencia in-memory vía puerto, lista para cablear cuando existan `IncidentSignature` / `ResolutionRecord` / `RcaFeedback`.

**Nomenclatura:** Ekumetrics Agent = recolector. Este módulo no es un AIOps Agent; es una **señal** (`historicalScore`) que RcaEngine puede consultar. HolmesGPT / LLM no participan.

---

## Files changed

| Path | Rol |
|---|---|
| `ekumetrics-platform/apps/platform-api/src/aiops/historical/types.ts` | `IncidentSignature`, `ResolutionRecord`, `RcaFeedback`, `HistoricalMatch`, `HistoricalContribution` |
| `ekumetrics-platform/apps/platform-api/src/aiops/historical/signature.ts` | Hash SHA-256 de características estables |
| `ekumetrics-platform/apps/platform-api/src/aiops/historical/similarity.ts` | Jaccard ponderado + cap de falso positivo |
| `ekumetrics-platform/apps/platform-api/src/aiops/historical/historical-evidence.port.ts` | `HistoricalEvidencePort` + contribución NEUTRAL |
| `ekumetrics-platform/apps/platform-api/src/aiops/historical/historical.repository.ts` | Puerto de persistencia |
| `ekumetrics-platform/apps/platform-api/src/aiops/historical/in-memory.historical.repository.ts` | Store por tenant (Map anidado) |
| `ekumetrics-platform/apps/platform-api/src/aiops/historical/historical.service.ts` | Lookup, firma, feedback, side-effects de ResolutionRecord |
| `ekumetrics-platform/apps/platform-api/src/aiops/historical/historical.controller.ts` | API tenant-scoped |
| `ekumetrics-platform/apps/platform-api/src/aiops/historical/historical.module.ts` | Nest module |
| `ekumetrics-platform/apps/platform-api/src/aiops/historical/historical.metrics.ts` | Series Prometheus |
| `ekumetrics-platform/apps/platform-api/src/aiops/historical/index.ts` | Barrel para RcaEngine (Task 2) |
| `ekumetrics-platform/apps/platform-api/src/aiops/historical/*.spec.ts` | Tests |
| `ekumetrics-platform/apps/platform-api/src/app.module.ts` | Importa `HistoricalModule` |

No se editó `schema.prisma`, CorrelationService, RcaEngine, AgentOrchestrator, ni UI.

---

## Signature algorithm

Características **estables** (normalizadas: trim, lowercase, sets ordenados):

| Campo | En el hash | Notas |
|---|---|---|
| `entityTypes` | sí | tipos (`database`, `K8S_POD`), no `entityId` |
| `serviceKey` | sí | alias de input: `service` / `serviceKey` |
| `eventTypes` | sí | p.ej. `alert.received`, `metric.anomaly` |
| `anomalyTypes` | sí | p.ej. `latency`, `saturation` |
| `topologyPattern` | sí | camino de **tipos** (`database>service`), no nodeKeys |
| `environment` | sí | `production`, `staging`, … |
| `tenantId` | **no** | unicidad `(tenantId, hash)` en el repositorio |
| `incidentId`, `entityIds`, `fingerprints`, timestamps, UUIDs, IPs | **no** | volátiles; se ignoran |

Canonical payload:

```
v1|{entityTypes sorted}|{serviceKey}|{eventTypes}|{anomalyTypes}|{topologyPattern}|{environment}
```

`hash = SHA-256(payload)` hex. Tokens de topología que parecen UUID / IPv4 / hex largo se descartan.

---

## Similarity formula

Algoritmo: `deterministic_jaccard_v1`. Fuente: `historical_intelligence`.

Pesos (renormalizan si una dimensión está vacía en **ambos** lados):

| Dimensión | Peso | Métrica |
|---|---|---|
| service | 0.25 | igualdad exacta |
| entityTypes | 0.20 | Jaccard |
| eventTypes | 0.20 | Jaccard |
| anomalyTypes | 0.15 | Jaccard |
| topologyPattern | 0.15 | Jaccard de tokens del camino |
| environment | 0.05 | igualdad exacta |
| rootCause | bonus +0.08 (cap 1.0) | solo si query y ResolutionRecord tienen causa |

**Cap de falso positivo:** si `eventTypes` y `topologyPattern` son comparables y ambos Jaccard &lt; 0.2, `similarity = min(score, 0.45)`. Mismo servicio + distinta topología/eventos **no** puede acercarse a 1.0.

Cada match incluye `similarity`, `confidence`, `evidence[]` (desglose por dimensión), `algorithm`, `source`.

### Contribución a RCA (`HistoricalEvidencePort.lookup`)

| Situación | `historicalScore` | `stance` | `matches` |
|---|---|---|---|
| Sin historial del tenant | **0.5 (NEUTRAL)** | `NEUTRAL` | `[]` |
| Matches débiles (≤ 0.5) | **0.5 (NEUTRAL)** | `NEUTRAL` | candidatos (explicables) |
| Mejor match &gt; 0.5 | similarity del mejor | `SUPPORTING` | top 10 |

`overridesCurrentEvidence` es **siempre `false`**. El histórico es una señal, no un veto. Si no hay historia **no se fabrica** causa ni matches.

Import para Task 2:

```ts
import {
  HISTORICAL_EVIDENCE,
  NeutralHistoricalEvidence,
  type HistoricalEvidencePort,
} from '../historical';
```

`NeutralHistoricalEvidence` sirve a tests de RcaEngine sin store.

---

## APIs

Guards: `@Roles('operator', 'admin')` + `actingTenant` (`?as=` / `X-Eku-Tenant`). El `tenantId` persistido es `Tenant.id`, nunca el slug del body. El incidente debe existir en ese tenant (404 si no).

| Método | Ruta | Uso |
|---|---|---|
| `POST` | `/v1/incidents/:incidentId/rca-feedback` | Persistencia operador: `CONFIRM` \| `REJECT` \| `SELECT_ALTERNATIVE` \| `ADD_NOTE` |
| `GET` | `/v1/incidents/:incidentId/rca-feedback` | Listado append-only |
| `GET` | `/v1/incidents/:incidentId/historical` | `{ contribution, resolution, feedback }` |
| `POST` | `/v1/incidents/:incidentId/historical/lookup` | Indexa firma + lookup (IDs volátiles en body se ignoran) |
| `GET` | `/v1/incidents/:incidentId/resolution` | `ResolutionRecord` (404 si no hay) |

`CONFIRM` / `REJECT` / `SELECT_ALTERNATIVE` / `ADD_NOTE` actualizan `ResolutionRecord` (causa confirmada, rechazadas, nota, `timeToDetectMs` / `timeToResolveMs`, `successfulAction`).

Audit: `aiops.rca.feedback` en el POST de feedback.

---

## Tests

Desde `ekumetrics-platform/apps/platform-api`:

```
npx jest src/aiops/historical --runInBand
```

Cubren:

- estabilidad de firma (IDs volátiles no cambian el hash)
- matching determinista
- sin historial → vacío + NEUTRAL
- falso positivo (mismo servicio, distinta topología/eventos)
- aislamiento cross-tenant
- persistencia de las cuatro acciones de feedback
- API 404 si el incidente no pertenece al tenant

---

## Observability

Series (contributor `aiops-historical` en `MetricsService`):

- `aiops_historical_lookups_total{outcome="neutral|matched"}`
- `aiops_rca_feedback_total{action="CONFIRM|REJECT|SELECT_ALTERNATIVE|ADD_NOTE"}`

Logs en texto plano, sin iconos: `aiops historical lookup tenantId=...`.

---

## Limitations

- Persistencia **in-memory** (se pierde al reiniciar). Prisma `IncidentSignature` / `ResolutionRecord` / `RcaFeedback` no existen aún; el coordinador Wave 2 es dueño del schema.
- Matching por barrido de firmas del tenant (OK para fundación; no hay índice aproximado).
- **Embeddings / pgvector diferidos.** Existe pgvector para RAG de EkuAssistant (`AiKnowledgeChunk`); no se reutiliza aquí. La similitud determinista cubre el DoD de Wave 2 sin un segundo almacén vectorial.
- No se implementó AgentOrchestrator, AnomalyEngine, scoring RCA completo ni rediseño de UI.
- `timeToDetect` / `timeToResolve` se informan en el feedback; no se calculan solos desde `Incident.windowStart`.
- El lookup HTTP indexa la firma del incidente actual pero **excluye** ese `incidentId` de los matches (no contar el caso presente como historial).
