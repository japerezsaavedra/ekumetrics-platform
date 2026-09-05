# Wave 1 — Correlation Engine V2

Evolución de `CorrelationService` (no hay un motor competidor). La agrupación V1 se conserva; el scoring V2 explica **por qué** se correlacionó un cluster.

**Nomenclatura:** el recolector es Ekumetrics Agent / collector. Aquí no se llama «agent» al recolector. Los fingerprints persistidos se referencian como eventos del recolector (`collectorEvents`).

## Qué no cambió (compatibilidad)

- Fuente: alertas activas de Alertmanager.
- Cluster: mismo `siteId` + ventana temporal + `sharePath` en el grafo (`hops`).
- Si falta `nodeKey` en alguno de los lados, se agrupa igual (sitio + ventana).
- Si falta `startsAt`, se considera dentro de ventana.
- `clusterKey` = SHA-256 de fingerprints de alerta ordenados y unidos por `|`.
- Causa preliminar: `commonCover` (grafo). Confianza heurística V1 en `Incident.confidence`.
- Persistencia: upsert si existe incidente `open` | `acknowledged` con el mismo `clusterKey` y `tenantId`.
- Enum de estado: `open` / `acknowledged` / `resolved` / `closed`. Sin DETECTED ni LLM.
- `members.alerts[]` sigue teniendo `fingerprint`, `name`, `severity`, `nodeHint`.
- `members.impact` se conserva.
- No se tocó Prisma, ingest, GraphService, portal ni shared-contracts.

## Qué se añadió

### Scoring configurable

Componentes (0..1):

| Campo | Qué mide |
|---|---|
| `temporalScore` | Cercanía en el tiempo dentro de la ventana |
| `entityScore` | Misma entidad / hint de activo |
| `topologyScore` | Distancia de hops en el grafo |
| `labelScore` | Etiquetas compartidas (`application`, `job`, `service`, …) |
| `historicalScore` | Incidentes previos **del mismo tenant** (mismo cluster resuelto o misma causa) |

`total` = suma ponderada. Pesos por defecto y **override por env** (se normalizan a 1):

| Variable | Default |
|---|---|
| `AIOPS_CORRELATION_WEIGHT_TEMPORAL` | 0.25 |
| `AIOPS_CORRELATION_WEIGHT_ENTITY` | 0.25 |
| `AIOPS_CORRELATION_WEIGHT_TOPOLOGY` | 0.25 |
| `AIOPS_CORRELATION_WEIGHT_LABEL` | 0.15 |
| `AIOPS_CORRELATION_WEIGHT_HISTORICAL` | 0.10 |
| `AIOPS_CORRELATION_WINDOW_MS` | 300000 (5 min) |
| `AIOPS_CORRELATION_HOPS` | 4 |

### Salida explicable

En `Incident.members.correlation`:

```json
{
  "score": 0.86,
  "components": {
    "temporalScore": 0.86,
    "entityScore": 1,
    "topologyScore": 1,
    "labelScore": 0.67,
    "historicalScore": 0
  },
  "weights": { "temporal": 0.25, "entity": 0.25, "topology": 0.25, "label": 0.15, "historical": 0.1 },
  "evidence": [
    "Ocurrieron a 43 segundos de diferencia (ventana de 5 min). La coincidencia en el tiempo no demuestra que una alerta cause la otra.",
    "Misma entidad: api-pagos",
    "Camino de dependencia a distancia 1",
    "Etiqueta compartida: application=pagos",
    "Sin incidentes previos del mismo tenant con este patrón",
    "La coincidencia en el tiempo no demuestra que una alerta cause la otra."
  ],
  "details": []
}
```

`confidence` del incidente **sigue siendo la heurística V1** (causa en grafo). El score V2 vive en `members.correlation` para no cambiar el significado de la UI actual.

### Temporal ≠ causalidad

Queda explícito en evidencia (`kind: causality`) y en las frases temporales. Correlacionar por ventana no afirma que una alerta cause la otra.

### Deduplicación / fingerprint

- Dedup de alertas por `fingerprint` antes de clusterizar.
- Lookup de `AgentEvent` por `(tenantId, fingerprint)` para enriquecer entidad y adjuntar `members.collectorEvents`.
- El `clusterKey` sigue basado en fingerprints de **alerta** (compatibilidad).

### Aislamiento de tenant

Todas las lecturas (grafo, incidentes históricos, eventos del recolector, upsert) filtran `tenantId`. `list` / `get` no cruzan tenants.

### Métricas

Patrón Prometheus de platform-api (`CorrelationMetrics` + `MetricsService.registerContributor`):

- `aiops_correlation_duration_seconds` (histograma)
- `aiops_correlations_total{outcome="created|updated|empty"}`

`CorrelationService` registra el contribuidor `aiops-correlation` en `MetricsService`, de modo que las series aparecen en `GET /metrics` junto al resto de la API. También se pueden leer con `CorrelationService.renderMetrics()`.

## Archivos

| Archivo | Rol |
|---|---|
| `apps/platform-api/src/aiops/correlation.service.ts` | Motor evolucionado |
| `apps/platform-api/src/aiops/correlation-types.ts` | DTO `CorrelationEvidence`, `CorrelationScore` |
| `apps/platform-api/src/aiops/correlation-weights.ts` | Defaults + env |
| `apps/platform-api/src/aiops/correlation-score.ts` | Scoring puro |
| `apps/platform-api/src/aiops/correlation-metrics.ts` | Contadores/histograma |
| `apps/platform-api/src/aiops/incidents.module.ts` | Provider `CorrelationMetrics` + import ObservabilityModule |
| `apps/platform-api/src/observability/metrics.service.ts` | `registerContributor` para scrape `/metrics` |
| `apps/platform-api/src/aiops/correlation*.spec.ts` | Tests |
| `docs/aiops/wave-1-correlation.md` | Este documento |

`graph-walk.ts` **no se modificó**. `GraphService` se usa tal cual.

## Tests

- Compat V1: sitio, ventana 5 min, hops, timestamps ausentes, `clusterKey`, causa `commonCover`, upsert `open`/`acknowledged`, no reabrir `resolved`/`closed`.
- Scoring: temporal, entidad, topología, labels, histórico, pesos, evidencia de no-causalidad.
- Cross-tenant: `get`/`list`/`merge`/historial/`AgentEvent` acotados a `tenantId`.
- Dedup por fingerprint + enriquecimiento del recolector.
- Métricas Prometheus.

## Limitaciones conocidas

- Correlación sigue siendo on-demand (`POST /v1/incidents/correlate`), no continua.
- Alertmanager fingerprint y `AgentEvent.fingerprint` rara vez coinciden (hashes distintos); el cruce aplica cuando son iguales.
- Histórico no consulta el JSON `members` (sin índice); usa `clusterKey` / `causeKey`.
- `Incident.confidence` permanece en la heurística V1; el score explicable está en `members.correlation`.
- Sin LLM, Redis, Kafka ni Neo4j.
