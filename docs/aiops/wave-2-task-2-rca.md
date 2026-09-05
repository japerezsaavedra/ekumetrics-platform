# Wave 2 — Task 2: RCA Engine determinista

Implementación del contrato Wave 1 `RcaEngine` en `platform-api`. **No** hay LLM, **no** hay Holmes, **no** hay `AgentOrchestrator` ni remediación. La correlación V1/V2 y el AnomalyEngine no se reescriben.

Nomenclatura: **Ekumetrics Agent** = recolector. **RcaEngine** / **RcaAgent** = investigador lógico AIOps. El string suelto `agent` no se reutiliza para ambos.

## Scoring (configurable)

Score final, pesos normalizados a 1 (por tenant vía `Policy` `kind`/`name` = `rca_scoring`, si no env, si no default):

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
| `temporalScore` | Candidato **antes** de fallos en dependientes (aguas abajo). Señal, **no** causalidad. | `0.5` si no hay dependiente afectado o faltan timestamps |
| `topologyScore` | Ancestro común, radio de explosión, camino, distancia | `0` si no hay camino al resto del incidente |
| `anomalyScore` | `AnomalyResult.score` × confianza del detector | `0` (no se fabrica anomalía) |
| `dependencyScore` | Fallo en una **dependencia** > fallo en un **dependiente** (PostgreSQL > API > Frontend) | `0.5` si no hay dirección en el grafo |
| `historicalScore` | Coincidencia histórica del **mismo tenant** | **neutro `0.5`**; nunca se inventa historial |

Defaults (`DEFAULT_RCA_WEIGHTS`): temporal `0.20`, topology `0.25`, anomaly `0.20`, dependency `0.25`, historical `0.10`.

| Variable / Policy | Default |
|---|---|
| `AIOPS_RCA_WEIGHT_TEMPORAL` | 0.20 |
| `AIOPS_RCA_WEIGHT_TOPOLOGY` | 0.25 |
| `AIOPS_RCA_WEIGHT_ANOMALY` | 0.20 |
| `AIOPS_RCA_WEIGHT_DEPENDENCY` | 0.25 |
| `AIOPS_RCA_WEIGHT_HISTORICAL` | 0.10 |
| `AIOPS_RCA_HOPS` | 8 |

`confidence` no es el score: combina el score con cuántas señales independientes hay (topología, dependencia dirigida, anomalía, precedencia, historial disponible). Alertas solo cercanas en el tiempo **sin grafo** no obtienen score causal alto.

Algoritmo: `weighted_subscores_v1`. Source: `deterministic_rca`.

## Explicabilidad

Cada `RootCauseCandidate` lleva `score`, `confidence`, `evidence[]`, `algorithm` / `source`. Cada ítem de evidencia incluye `facts.algorithm` y `facts.score`.

Ejemplo de hipótesis (no el texto corto «Database issue.»):

> PostgreSQL PROD es el candidato principal de causa raíz porque: anomalía de latency score 0.94; la anomalía comenzó 34s antes que los errores de API Pagos; la topología muestra 2 entidades impactadas que dependen de esta dependencia; no se detectó anomalía aguas arriba. Score 0.85, confianza 0.91, algoritmo weighted_subscores_v1.

Evidencia explícita: *la precedencia temporal es una señal, no una prueba de causalidad.*

## EventBus (subjects Wave 1, sin duplicar)

| Dirección | Subject | Payload |
|---|---|---|
| subscribe | `ekumetrics.rca.requested` | `{ tenantId, incidentId, investigationId?, entityKeys?, preliminaryCauseKey? }` |
| publish | `ekumetrics.rca.completed` | `{ tenantId, incidentId, algorithm, durationMs, candidateCount, primaryEntityId?, rcaConfidence?, leadingScore?, leadingConfidence?, candidates[] }` |

`headers.tenantId` obligatorio y debe coincidir con `payload.tenantId`. Consumer durable: `aiops-rca-engine`. No se llama a `propose()` desde ingest HTTP.

Contrato compartido en `src/aiops/contracts/events.ts` (`RcaRequestedPayload` / `RcaCompletedPayload`); el payload de completed incluye además `candidates[]` explicables para enrichment.

## OTel / Prometheus

Mismo patrón que correlación (`RcaMetrics` + `MetricsService.registerContributor`):

- `aiops_rca_requests_total`
- `aiops_rca_completed_total{outcome="ok\|empty\|error"}`
- `aiops_rca_duration_seconds`
- `aiops_rca_confidence` (histograma del candidato principal)

## Archivos

```
ekumetrics-platform/apps/platform-api/src/aiops/rca/
  engine.ts                 # DeterministicRcaEngine implements RcaEngine
  scorer.ts                 # scoring puro
  explain.ts                # hipótesis
  scoring-policy.ts         # RcaScoringPolicy (Policy JSON + env)
  subscriber.ts             # EventBus
  metrics.ts
  historical-evidence.port.ts   # + adaptador neutro (Task 5)
  anomaly-evidence.port.ts      # AnomalyResult; noop hasta AnomalyEngine
  incident-source.ts
  rca.module.ts
docs/aiops/wave-2-task-2-rca.md
```

Contrato existente (no se duplicó): `interfaces/rca-engine.ts` → `RootCauseCandidate`.

## Tests

Desde `ekumetrics-platform/apps/platform-api`:

```
npx jest src/aiops/rca src/aiops/stubs/aiops-stubs.spec.ts src/aiops/types/rca-domain.spec.ts
```

- Ranking dependencia PostgreSQL > Frontend
- Precedencia temporal sube `temporalScore`; falso positivo sin topología no tiene score causal alto
- Sin historial → `historicalScore = 0.5`
- Evidencia explicable (score, confidence, algoritmo)
- Aislamiento cross-tenant
- Cambio de pesos cambia el ranking
- Roundtrip EventBus `requested` → `completed`

## Limitaciones

- `Incident.causeKey` sigue siendo caché de correlación; RCA no escribe `Incident.status`.
- `HistoricalEvidencePort` es neutro hasta Task 5.
- `AnomalyEvidencePort` es no-op hasta que AnomalyEngine publique `AnomalyResult`.
- Nadie en Wave 2 Task 2 publica `rca.requested` desde correlación (el orquestador / otra tarea puede engancharlo). El motor y el subscriber están listos.
- `RootCauseCandidate` sigue sin tabla Prisma.
- Precedencia temporal **no** se trata como causalidad.
