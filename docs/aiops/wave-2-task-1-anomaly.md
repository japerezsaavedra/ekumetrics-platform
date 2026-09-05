# Wave 2 — Task 1: Anomaly Engine

**Estado:** implementado. Sin LLM. Sin Holmes.  
**Fecha:** 2026-09-05  
**Código:** `ekumetrics-platform/apps/platform-api/src/aiops/anomaly/`

Nomenclatura: **Ekumetrics Agent** = recolector. **AnomalyEngine** = motor numérico de plataforma. Un AIOps Agent (Rca, Metrics, …) no vive en este módulo.

Wave 1 (EventBus, NATS, ingest, CorrelationService, grafo) no se reescribe. La detección **no** corre en el path HTTP de `POST /v1/ekms/events`.

---

## Archivos

| Path | Rol |
|---|---|
| `apps/platform-api/src/aiops/anomaly/anomaly.engine.ts` | Orquesta detectores, política por tenant, persistencia, publish |
| `apps/platform-api/src/aiops/anomaly/anomaly.worker.ts` | Consumer `ekumetrics.events.ingested` (`aiops-anomaly-engine`) |
| `apps/platform-api/src/aiops/anomaly/anomaly.module.ts` | Nest; importado en `AppModule` |
| `apps/platform-api/src/aiops/anomaly/anomaly-result.ts` | `AnomalyResult` / payload (RCA puede importar `./anomaly` o `../contracts`) |
| `apps/platform-api/src/aiops/anomaly/anomaly-detector.ts` | Interfaz `AnomalyDetector` |
| `apps/platform-api/src/aiops/anomaly/detectors/static-threshold.detector.ts` | Umbrales `PlatformThresholds` + política |
| `apps/platform-api/src/aiops/anomaly/detectors/rolling-baseline.detector.ts` | Mediana / IQR / percentiles (ventanas 5m–24h) |
| `apps/platform-api/src/aiops/anomaly/detectors/robust-zscore.detector.ts` | Mediana + MAD; score 0..1 |
| `apps/platform-api/src/aiops/anomaly/detectors/ewma.detector.ts` | Deriva gradual (alpha/lambda de política) |
| `apps/platform-api/src/aiops/anomaly/detectors/advanced-stubs.ts` | Interfaces `ChangePoint` / `IsolationForest` / `SeasonalBaseline` |
| `apps/platform-api/src/aiops/anomaly/metric-window.store.ts` | Buffer acotado 24h, tenant-scoped |
| `apps/platform-api/src/aiops/anomaly/anomaly.repository.ts` | Puerto + in-memory (Prisma `AiopsAnomaly` se puede cablear) |
| `apps/platform-api/src/aiops/anomaly/anomaly-policy.repository.ts` | Puerto + in-memory (`AiopsAnomalyPolicy`) |
| `apps/platform-api/src/aiops/anomaly/platform-threshold.source.ts` | Reusa `PlatformThresholds` (no duplica la tabla) |
| `apps/platform-api/src/aiops/anomaly/anomaly-metrics.ts` | Prometheus `aiops_anomalies_*` |
| `apps/platform-api/src/aiops/anomaly/*.spec.ts` | Jest |
| `apps/platform-api/src/messaging/subjects.ts` | `ANOMALIES_DETECTED` |
| `apps/platform-api/src/aiops/contracts/` | Contratos compartidos Wave 2 (importar, no forkar) |

No se tocó `CorrelationService`, `Incident`, `GraphService` ni el schema Prisma.

---

## Algoritmos

Todos emiten `score` y `confidence` en `[0, 1]`, `algorithm`, `window` y `metadata.evidence` (nunca opacos).

| Detector | Qué hace | Cuándo emite |
|---|---|---|
| `static_threshold` | Compara el último valor con warn/crit de `PlatformThresholds` (mapeo por nombre de métrica) o override de política | Valor ≥ warn (`above`) o ≤ warn (`below`) |
| `rolling_baseline` | Mediana, IQR, p05/p95, media/stddev **solo como evidencia**. Cerca de Tukey; no asume normalidad | Fuera de Q1/Q3 ± k·IQR, o quiebre de serie plana (IQR=0) |
| `robust_zscore` | Z modificado Iglewicz-Hoaglin: `0.6745 · (x − median) / MAD`. Score = `min(1, \|z\|/6)` | `\|z\| ≥ 3.5` (configurable). MAD=0 y valor ≠ mediana = quiebre |
| `ewma` | EWMA rápida/lenta (alpha/lambda) + desplazamiento mediana primer vs último cuarto | Deriva (`mode=drift`) o residuo (`mode=spike`) ≥ `minScore` |
| Stubs | `change_point`, `isolation_forest`, `seasonal_baseline` | Siempre `[]` |

Ventanas evaluadas (puntos acotados; no se consulta el historial completo): `5m`, `15m`, `1h`, `24h`. El motor se queda con el mejor score por algoritmo.

---

## Configuración

Política por tenant, con targeting opcional `siteId`, `entityType`, `entityId`, `metricName`, `environment`. Gana la más específica.

Defaults (`DEFAULT_ANOMALY_POLICY`):

| Campo | Default |
|---|---|
| `minScore` | 0.35 |
| `minSamples` | 8 (1 para estático) |
| `ewmaAlpha` / `ewmaLambda` | 0.3 / 0.05 |
| `robustZThreshold` | 3.5 |
| `rollingIqrK` | 1.5 |
| `staleMs` | 5 min (último punto más viejo → no se evalúa) |
| `enabledDetectors` | los cuatro implementados |

`StaticThreshold` lee `PlatformThresholds` del tenant (`cpuWarn`/`cpuCrit`, …). No copia la tabla.

---

## NATS / EventBus

| Dirección | Subject | Constante |
|---|---|---|
| Consume | `ekumetrics.events.ingested` | `EventSubjects.EVENTS_INGESTED` |
| Publica | `ekumetrics.anomalies.detected` | `EventSubjects.ANOMALIES_DETECTED` |

Consumer durable: `aiops-anomaly-engine`. Stream JetStream: `EKU_ANOMALIES`.

El dominio no importa `@nats-io/*`. Si el bus está degradado, la detección persiste en el puerto y el publish se omite (`aiops.anomaly.publish.skipped`).

### Payload `ekumetrics.anomalies.detected`

`headers.tenantId` **y** `payload.tenantId` son obligatorios. Mismatch → `term`.

```ts
{
  tenantId: string;
  entityId: string;
  metricName: string;
  detectedAt: string; // ISO
  anomalies: AnomalyResult[];
}
```

`AnomalyResult`:

```ts
{
  id, tenantId, entityId, metricName,
  timestamp, actualValue, expectedValue, deviation,
  score, confidence, algorithm, window,
  metadata: { evidence, source, sampleCount, stats?, mode?, thresholdSource?, ... }
}
```

Idempotency: `{tenantId}:anomalies.detected:{anomalyId}`.

---

## Tests

Desde `ekumetrics-platform/apps/platform-api`:

```bash
npm test -- anomaly.engine.spec metric-window.store.spec --runInBand
```

Cubre: normal, spike, deriva lenta, datos ausentes, línea plana, ruido, aislamiento cross-tenant, falsos positivos, payload EventBus con `tenantId`, stubs vacíos.

---

## Limitaciones

- Persistencia de producto: puerto in-memory por defecto. Las tablas Prisma `AiopsAnomaly` / `AiopsAnomalyPolicy` existen; el adaptador Prisma de umbrales sí lee `PlatformThresholds`. Cablear el repo Prisma no requiere cambiar detectores.
- Ingest HTTP **aún no** publica `events.ingested` (Wave 1). El worker queda listo; hasta que ingest publique, el motor se invoca por tests o por un productor posterior.
- Buffer de series en proceso (tope 24h / 1440 puntos / 5000 series). No es compartido entre réplicas.
- Change-point, Isolation Forest y baseline estacional son interfaces/stubs.
- Sin LLM: el motor es usable si Holmes/Ollama caen.
- No correlaciona, no abre incidentes, no orquesta AIOps Agents.
