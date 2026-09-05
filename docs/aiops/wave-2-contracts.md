# Wave 2 — Contratos compartidos Prisma + dominio AIOps

**Estado:** schema + contratos. **No** hay AnomalyEngine, scoring RCA, walk topológico, worker de enrichment ni matching histórico en este entregable.  
**Fecha:** 2026-09-05  
**Nomenclatura:** **Ekumetrics Agent** = recolector. **AIOps Agent** = investigador lógico en plataforma. HolmesGPT no orquesta.

Wave 1 permanece intacta: EventBus, NATS JetStream, CorrelationService V2, TopologyRepository, Incident, GraphNode/GraphEdge, AgentEvent, AiopsInvestigation, AgentFinding, stubs de orquestación.

---

## Decisión de persistencia

| Entidad | Estrategia | Por qué |
|---|---|---|
| `Incident`, `GraphNode`, `GraphEdge`, `AgentEvent` | **No duplicar.** Solo relaciones nuevas en `Incident`. | Wave 1. |
| `PlatformThresholds` | **Reusar** para `StaticThreshold`. | Umbrales SLO/capacidad ya existen (`cpuWarn`, `memCrit`, …). La política AIOps apunta al slot/clave; no copia números. |
| `Policy` | No es el store de pesos RCA. | Wave 2 introduce `RcaScoringPolicy`. El loader RCA puede migrar de `Policy.kind=rca_scoring` a esta tabla. |
| `AiopsAnomaly` | Tabla nueva | Resultado de detector; no es `AgentEvent`. |
| `AiopsAnomalyPolicy` | Tabla nueva | Targeting + `config` JSON por detector. |
| `IncidentEnrichment` | Tabla nueva **1:1** con `Incident` | Snapshot queryable + JSON de evidencia. |
| `IncidentSignature` / `ResolutionRecord` / `RcaFeedback` | Tablas nuevas | Histórico y feedback de operador. |
| `RcaScoringPolicy` | Tabla nueva | Pesos por tenant (+ environment). No es la fórmula. |
| `RootCauseCandidate` | Sigue **tipo TS** (sin tabla) | Wave 1: hipótesis transitoria; `Incident.cause*` es caché. |

Todas las filas llevan `tenantId`. Índices compuestos empiezan por `tenantId`. Queries de producto **siempre** filtran `tenantId`.

---

## Modelos Prisma

Schema: `ekumetrics-platform/apps/platform-api/prisma/schema.prisma`  
Migración: `ekumetrics-platform/apps/platform-api/prisma/migrations/20260905080000_wave2_aiops/migration.sql`

### AiopsAnomaly

Persiste `AnomalyResult`. `entityId` es clave lógica (`GraphNode.nodeKey` / `Asset.assetKey`), no FK Prisma (igual que `GraphEdge.fromKey`).

| Campo | Índice / nota |
|---|---|
| `tenantId`, `timestamp` | `@@index([tenantId, timestamp])` |
| `tenantId`, `entityId`, `metricName`, `timestamp` | serie por entidad/métrica |
| `tenantId`, `incidentId` | vínculo opcional; `onDelete: SetNull` |

`algorithm` = valor persistido (`static_threshold`, `robust_zscore`, …). `window` texto (`5m`). `metadata` JSON (evidencia, stats, `thresholdSource`).

### AiopsAnomalyPolicy

Targeting: `tenantId` + `siteId?` + `entityType?` + `entityId?` + `metric?` + `environment?`.  
`detectorType` string (`StaticThreshold` o `static_threshold`).  
`config` JSON tipado en TS. `weight` para mezclar detectores.  
`platformThresholdsId` FK opcional → `PlatformThresholds` (`onDelete: SetNull`).

**StaticThreshold:** `config.source = 'platform_thresholds'` + `platformThresholdsSlot` / `warnKey` / `critKey`. No duplicar `PlatformThresholds.values`. Override inline solo si `source = 'inline'`.

Resolución de política (aplicación): más específico gana (`entityId` > `metric` > `siteId` > `entityType` > `environment`). Sin unique en columnas nullable (NULLs distintos en PG).

### IncidentEnrichment (1:1 Incident)

`incidentId` `@unique` + `@@unique([tenantId, incidentId])`. Cascade al borrar Incident.

**Indexados:** `primaryRootCause`, `rcaConfidence`, `affectedServiceCount`.  
**JSON:** `affectedEntities`, `affectedServices`, `blastRadius`, `topologyEvidence`, `anomalies`, `rootCauseCandidates`, `correlationEvidence`, `timeline`, `recentChanges`, `historicalMatches`.

`primaryRootCause` = clave de entidad / hipótesis corta para filtros. El candidato completo va en JSON.

### IncidentSignature

`@@unique([tenantId, hash])`. `version` default `v1`. Arrays `entityTypes` / `eventTypes` / `anomalyTypes`.  
Índices: `(tenantId, serviceKey)`, `(tenantId, environment)`, `(tenantId, topologyPattern)`, `(tenantId, createdAt)`.

Matching: lookup por hash; candidatos por `serviceKey` + `environment` + `topologyPattern`. Jaccard sobre arrays en aplicación (sin GIN en MVP).

### ResolutionRecord / RcaFeedback

`RcaFeedback.action`: `CONFIRM` \| `REJECT` \| `SELECT_ALTERNATIVE` \| `ADD_NOTE` (enum Prisma; no lowercase).  
Índice `(tenantId, incidentId)` en ambos. `userId` lógico (sin FK a `User`).

### RcaScoringPolicy

`@@unique([tenantId, environment])` con `environment=""` = default del tenant.

Defaults (suman 1.0), alineados al workstream RCA:

| temporal | topology | anomaly | dependency | historical |
|---|---|---|---|---|
| 0.20 | 0.25 | 0.20 | 0.25 | 0.10 |

También: `hops` default 8, `suppressionEnabled`, `minTopologyConfidence`, `config` JSON.

Columnas Prisma: `temporalWeight`, …  Tipos TS de candidato: `RcaScoreWeights.temporal`, …  Mapear con `toPrismaRcaWeights` / `fromPrismaRcaWeights`.

---

## Patrones de query (todos con `tenantId`)

```ts
// Anomalías recientes de una entidad/métrica
prisma.aiopsAnomaly.findMany({
  where: { tenantId, entityId, metricName, timestamp: { gte: from } },
  orderBy: { timestamp: 'desc' },
});

// Anomalías ligadas a un incidente
prisma.aiopsAnomaly.findMany({ where: { tenantId, incidentId } });

// Políticas habilitadas (resolver especificidad en memoria)
prisma.aiopsAnomalyPolicy.findMany({ where: { tenantId, enabled: true } });

// Snapshot de enrichment
prisma.incidentEnrichment.findUnique({
  where: { incidentId /* o tenantId_incidentId */ },
});

// Firma histórica
prisma.incidentSignature.findUnique({ where: { tenantId_hash: { tenantId, hash } } });
prisma.incidentSignature.findMany({
  where: { tenantId, serviceKey, environment },
});

// Resoluciones por firma
prisma.resolutionRecord.findMany({ where: { tenantId, signatureId } });

// Feedback RCA
prisma.rcaFeedback.findMany({ where: { tenantId, incidentId }, orderBy: { createdAt: 'asc' } });

// Pesos RCA
prisma.rcaScoringPolicy.findUnique({
  where: { tenantId_environment: { tenantId, environment: '' } },
});
```

Nunca consultar estas tablas sin `tenantId` (salvo `findUnique` por `incidentId` de enrichment, que sigue exigiendo comprobar `row.tenantId === actingTenant`).

---

## Subjects EventBus

Único catálogo: `src/messaging/subjects.ts`. **No hardcodear strings.**

| Constante | Subject | Stream | Notas |
|---|---|---|---|
| `ANOMALIES_DETECTED` | `ekumetrics.anomalies.detected` | `EKU_ANOMALIES` | **Nuevo** stream Wave 2 |
| `INCIDENTS_ENRICHMENT_REQUESTED` | `ekumetrics.incidents.enrichment.requested` | `EKU_INCIDENTS` | Wave 1 ya mapeaba `incidents.>` |
| `INCIDENTS_ENRICHED` | `ekumetrics.incidents.enriched` | `EKU_INCIDENTS` | |
| `RCA_REQUESTED` | `ekumetrics.rca.requested` | `EKU_RCA` | **Reutilizado** Wave 1 |
| `RCA_COMPLETED` | `ekumetrics.rca.completed` | `EKU_RCA` | **Reutilizado** Wave 1 |

Todo mensaje **debe** llevar `headers.tenantId` (EventBus Wave 1) **y** `payload.tenantId`. Usar `assertAiopsBusPayload` y `buildHeaders({ tenantId, correlationId, ... })`. Mismatch header/payload → `term` (poison), igual que Wave 1.

Idempotency recomendada: `{tenantId}:{subject}:{claveNatural}`.

---

## Métricas OpenTelemetry / Prometheus

Constantes: `AiopsMetricNames` en `src/aiops/contracts/metrics.ts`.

| Nombre |
|---|
| `aiops_anomalies_detected_total` |
| `aiops_anomaly_detection_duration_seconds` |
| `aiops_rca_requests_total` |
| `aiops_rca_completed_total` |
| `aiops_rca_duration_seconds` |
| `aiops_rca_confidence` |
| `aiops_topology_correlations_total` |
| `aiops_root_cause_suppressions_total` |
| `aiops_incident_enrichment_duration_seconds` |

Wave 1 sigue emitiendo `aiops_correlation_*` desde `CorrelationMetrics` (no se reimplementa aquí).

---

## Contratos TypeScript

Módulo canónico:

```
ekumetrics-platform/apps/platform-api/src/aiops/contracts/
```

Barrels finos por workstream (no son la implementación):

| Workstream | Import preferido |
|---|---|
| Anomalía | `../contracts` o `./wave2-contracts` |
| RCA | `../contracts` o `./wave2-contracts` |
| Topología | `../contracts` o `./wave2-contracts` |
| Enrichment | `../contracts` o `./wave2-contracts` |
| Histórico | `../contracts` o `./wave2-contracts` |

```ts
import {
  EventSubjects,
  AiopsMetricNames,
  assertAiopsBusPayload,
  type AnomalyDetector,
  type AnomalyResult,
  type RcaEngine,
  type RootCauseCandidate,
  type IncidentEnrichmentRecord,
  type BlastRadius,
  type TopologyImpactResult,
} from '../contracts';
```

### Tipos clave

- **AnomalyDetector / AnomalyResult** — `detectorType` PascalCase (`StaticThreshold`, …) y `algorithm` snake_case persistido (`static_threshold`). Configs: StaticThreshold, RollingBaseline, RobustZScore, EWMA.
- **RcaEngine.propose** — input Wave 1 + `scoringPolicy`, `anomalies`, `topologyImpact`, `enrichment`. Implementación = workstream RCA. Stub Wave 1 sigue devolviendo `[]`.
- **RootCauseCandidate** — Wave 1 + `entityId`, `score`, `subscores` (`temporalScore`, `topologyScore`, `anomalyScore`, `dependencyScore`, `historicalScore`), `affectedEntities`, `affectedServices`, `firstObservedAt`. Factory `createScoredRootCauseCandidate`.
- **BlastRadius / TopologyImpactResult** — forma canónica de topology-correlation (`originKey`, hops, dependientes). Se persiste como JSON en enrichment.
- **IncidentEnrichmentRecord** — vista de dominio del snapshot 1:1.
- **IncidentSignatureRecord / ResolutionRecordView / RcaFeedbackRecord**
- **IncidentPriorityCalculator** — puerto; niveles `P1`–`P4`.
- **ExplainableOutput** — `{ score, confidence, evidence, algorithm, source? }`.

Payloads de bus: todos extienden `{ tenantId: string }`.

---

## Cómo deben importar los 5 workstreams

### 1. Anomalía

```ts
import {
  EventSubjects,
  AiopsMetricNames,
  DETECTOR_TYPE_TO_ALGORITHM,
  assertAiopsBusPayload,
  type AnomalyDetector,
  type AnomalyResult,
  type AiopsAnomalyPolicyRecord,
  type AnomaliesDetectedPayload,
} from '../contracts';
```

Prisma: `prisma.aiopsAnomaly` / `prisma.aiopsAnomalyPolicy`.  
Publicar `EventSubjects.ANOMALIES_DETECTED`.  
StaticThreshold: leer `PlatformThresholds` (servicio platform), no copiar JSON de umbrales.

### 2. RCA

```ts
import {
  RCA_ENGINE,
  EventSubjects,
  AiopsMetricNames,
  defaultRcaScoringPolicy,
  fromPrismaRcaWeights,
  type RcaEngine,
  type RcaProposeInput,
  type ScoredRootCauseCandidate,
} from '../contracts';
```

Prisma: `prisma.rcaScoringPolicy` (dejar de depender de `Policy` genérico cuando exista fila).  
Consumir `RCA_REQUESTED`, publicar `RCA_COMPLETED`.  
No hardcodear la fórmula final; leer pesos de la política.

### 3. Topología / correlación topológica

```ts
import {
  AiopsMetricNames,
  blastRadiusEntityCount,
  type BlastRadius,
  type TopologyImpactResult,
} from '../contracts';
```

Seguir usando `TopologyRepository` Wave 1 (`GraphNode`/`GraphEdge`). No segundo grafo.  
Métrica: `aiops_topology_correlations_total`, `aiops_root_cause_suppressions_total`.

### 4. Enrichment

```ts
import {
  EventSubjects,
  AiopsMetricNames,
  type IncidentEnrichmentRecord,
  type IncidentPriorityCalculator,
} from '../contracts';
```

Prisma: `prisma.incidentEnrichment` upsert 1:1 por `incidentId` + `tenantId`.  
Subjects: `INCIDENTS_ENRICHMENT_REQUESTED` / `INCIDENTS_ENRICHED`.  
`affectedServiceCount` = longitud de servicios afectados (columna indexada).

### 5. Histórico

```ts
import {
  RCA_FEEDBACK_ACTIONS,
  type IncidentSignatureRecord,
  type ResolutionRecordView,
  type RcaFeedbackRecord,
} from '../contracts';
```

Prisma: `incidentSignature`, `resolutionRecord`, `rcaFeedback`.  
`RcaFeedbackAction` en API de operador debe mapearse al enum Prisma **uppercase**.

---

## Fuera de alcance (este entregable)

- Implementar detectores, `RcaEngine.propose` real, BFS/blast radius, worker NATS de enrichment, similitud histórica.
- `AgentOrchestrator` / loop multi-agente / remediación autónoma.
- Tablas `CanonicalEvent`, `IncidentCandidate`, `ExternalTicketLink`, `RemediationAction`.
- Duplicar `Incident` / grafo / `AgentEvent`.

---

## Migración

**Path:** `ekumetrics-platform/apps/platform-api/prisma/migrations/20260905080000_wave2_aiops/migration.sql`

Crea enum `RcaFeedbackAction` y tablas `AiopsAnomaly`, `AiopsAnomalyPolicy`, `IncidentEnrichment`, `IncidentSignature`, `ResolutionRecord`, `RcaFeedback`, `RcaScoringPolicy`. Índices tenant-scoped + FKs a `Tenant` / `Incident` / `PlatformThresholds`. No altera columnas de `Incident`, `GraphNode`, `GraphEdge` ni `AgentEvent`.

Siguientes migraciones (otros workstreams): `20260905120000_wave25_durability` (`snapshot`, `incidentIds`, `AiopsEventOutbox`); `20260905180000_wave3_investigation` (política de investigación).

```
cd ekumetrics-platform/apps/platform-api
npx prisma generate
npx prisma migrate deploy
```

No usar `migrate reset`. El SQL ya está en el repo; `migrate deploy` lo aplica si `DATABASE_URL` apunta a un Postgres de desarrollo.

---

## Tests de contratos

```
cd ekumetrics-platform/apps/platform-api
npx jest src/aiops/contracts/wave2-contracts.spec.ts src/messaging/event-bus.spec.ts src/aiops/types/rca-domain.spec.ts
```
