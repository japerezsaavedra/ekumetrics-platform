# Wave 1 — Event domain (`AgentEvent`)

Evolución del evento de plataforma para AIOps **sin** tabla `CanonicalEvent` duplicada. `AgentEvent` es la unidad persistida de señal (recolector + metadatos AIOps opcionales).

## Decisión

| Opción | Resultado |
|---|---|
| Nueva tabla `CanonicalEvent` | **No.** Duplicaría fingerprint, tenant, tiempo y labels. |
| Reusar `AgentEvent` | **Sí.** Columnas indexadas mínimas + `metadata` JSON. |
| Redis / Kafka / Neo4j | **No.** |

Los envelopes actuales del Ekumetrics Agent siguen siendo válidos. Todo lo nuevo es opcional.

## Schema diff (`AgentEvent`)

Columnas nuevas (todas nullable):

| Columna | Uso | Por qué columna y no JSON |
|---|---|---|
| `category` | `ALERT` \| `METRIC_SIGNAL` \| `LOG_SIGNAL` \| `CHANGE` \| `DEPLOY` \| `ASSET` \| `NEIGHBOR` \| `FLOW` \| `TRAP` | filtro / agrupación |
| `entityType` | tipo de entidad AIOps (`device`, `K8S_POD`, …) | selector de investigación |
| `correlationKey` | clave de agrupación | join con correlación |
| `environment` | `production`, `staging`, … | filtro tenant-scoped |
| `traceId` | traza OTel | cruce con Tempo |
| `metadata` | JSON flexible | no se filtra por índice |

`metadata` admite: `labels`, `attributes`, `baseline`, `deviation`, `anomalyScore`, `metricName`, `entityId`, `spanId`.

Ya existían y se reutilizan: `severity`, `value`, `signal`, `assetKey`/`assetType`, `tags`, `fingerprint`, `tenantId`, `siteId`, `eventAt`.

Migración única: `20260904233000_agent_event_aiops_metadata` (backwards compatible).

Índices tenant-scoped nuevos:

- `(tenantId, category, eventAt)`
- `(tenantId, entityType, eventAt)`
- `(tenantId, severity, eventAt)`
- `(tenantId, correlationKey, eventAt)`
- `(tenantId, environment, eventAt)`
- `(tenantId, traceId)`

No se tocó `GraphNode`, `GraphEdge`, `Incident`, ni modelos RCA.

## Contratos

OpenAPI `EkmsEvent` (`packages/shared-contracts/openapi/platform-v0.yaml`):

- Campos requeridos **sin cambio**: `timestamp`, `tenant_id`, `site_id`, `agent_id`, `signal`, `value`, `source`.
- Opcionales nuevos: `category`, `entity_type`, `correlation_key`, `environment`, `trace_id`, `metadata`.
- Señales: se documenta `neighbor_observed` (ya aceptada) y se añaden `metric.anomaly`, `log.signal`, `change.detected`, `deploy.observed`, `alert.received`.

Si el recolector no envía los opcionales, ingest infiere:

| Campo | Inferencia |
|---|---|
| `category` | desde `signal` |
| `entityType` | `asset_type` |
| `environment` | `tags.environment` |
| `traceId` | `tags.trace_id` / `tags.traceId` |

`tenantId` persistido es siempre el `Tenant.id` registrado, nunca el slug del envelope ni un valor dentro de `metadata`.

## Fingerprint / compatibilidad

El hash de envelopes antiguos (sin campos AIOps explícitos) **no cambia**. Los extras solo entran al fingerprint si vienen en el payload. Reintentos del recolector actual siguen siendo idempotentes (`skipDuplicates`).

## Tests

- `ingest.types.spec.ts`: envelope viejo; inferencia; metadata AIOps; category inválida; isolation de metadata.
- `ingest.service.spec.ts`: persistencia; tenant isolation (`tenant-db` ≠ slug); fingerprint estable; fila AIOps.

## Limitaciones

- No hay proyección Alertmanager → `AgentEvent` en este workstream (correlación sigue en `CorrelationService`).
- No se publica al EventBus desde ingest (TASK 1).
- `value` sigue siendo obligatorio (contrato del recolector).
- `tags` se conserva; `metadata.labels` es el mapa estructurado para AIOps.
- OpenAPI documenta metadata en snake_case (`anomaly_score`, `metric_name`, `entity_id`, `span_id`); ingest también acepta camelCase y normaliza a camelCase al persistir.
- Filas ya retenidas reciben backfill de `category` / `entityType` / `environment` / `traceId` en la migración; el fingerprint no se reescribe.
