# Gap analysis AIOps — Ekumetrics

**Fecha:** 2026-09-04  
**Alcance:** comparación del código real del workspace frente a la arquitectura objetivo multi-capa.  
**Método:** lectura directa de `platform-api/src/aiops/`, Prisma, ingest, `ai/`, portal (incidentes/investigación/asistente), `ekumetrics-agent`, infra k8s/docker.  
**Fuera de alcance:** implementación, planes maestros, cambios de producto.

## Nomenclatura (invariantes)

| Término | Significado en este documento |
|---|---|
| **Ekumetrics Agent** | Recolector en borde (`ekumetrics-agent/`) |
| **AIOps Agents** | Investigadores lógicos (Rca, Metrics, Logs, Kubernetes, Topology, Synthesis, …) |
| **HolmesGPT / Ollama** | Motor/tool layer opcional; **no** orquestador ni motor de correlación |
| **LLM** | Capa de investigación/síntesis; el sistema debe operar si Holmes/Ollama/cloud fallan |

---

## 1. Arquitectura objetivo vs pipeline real

### Objetivo

```text
Ekumetrics Agent → Ingestion → NATS JetStream → Normalization
  → Observability + CMDB/Topology → AIOps Correlation → Incident Engine
  → RCA → Multi-Agent Investigation → ITSM / Remediation
```

### Real (hoy)

```text
Ekumetrics Agent
  ├─ OTLP (mTLS edge) → OTel Collector → Prometheus / Loki / Tempo
  └─ HTTP /v1/ekms/events → IngestService → PostgreSQL
       ├─ AgentEvent (+ fingerprint)
       ├─ Asset (CMDB ligera)
       └─ GraphNode/GraphEdge (neighbor_observed / LLDP)

Alertmanager → (manual) POST /v1/incidents/correlate
  → CorrelationService (ventana + grafo) → Incident (open|acknowledged…)

Operador → Portal /incidentes, /investigacion
Operador → /asistente (EkuAssistant + Holmes + RetrievalService)  ← paralelo, no pipeline de incidente
```

**Conclusión de pipeline:** la correlación y el incidente existen como MVP acotado; faltan EventBus/JetStream en el camino de datos, normalización dedicada, motor de incidentes con transiciones, RCA como agente, orquestación multi-agente, ITSM y remediación. NATS JetStream está desplegado pero **no** es bus de eventos de producto.

---

## 2. Inventario de lo reutilizable (con paths)

### Ekumetrics Agent (no duplicar)

| Capacidad | Path |
|---|---|
| Recolección, buffer, export EKMS | `ekumetrics-agent/pkg/ekms/` |
| Discovery pasivo ARP/LLDP/CDP → inventario | `ekumetrics-agent/pkg/modules/discovery/` |
| Señal `neighbor_observed` | `ekumetrics-agent/pkg/ekms/envelope/envelope.go` |
| Contrato de envío HTTP a platform | `ekumetrics-agent/pkg/ekms/buffer/send.go` |

### Ingestión y tenancy

| Capacidad | Path |
|---|---|
| Ingesta HTTP, auth borde, fingerprint, assets | `ekumetrics-platform/apps/platform-api/src/ingest/` |
| Upsert topología desde vecinos | `ingest.service.ts` → `GraphService.upsertNeighbor` |
| Tenant / Site / Agent / Asset | `prisma/schema.prisma` (`Tenant`, `Site`, `Agent`, `Asset`) |
| Módulos opcionales de tenant | `tenants/tenant-modules.ts` |

### Topología / CMDB parcial

| Capacidad | Path |
|---|---|
| Modelos `GraphNode`, `GraphEdge` | `prisma/schema.prisma` |
| Persistencia + snapshot + impact + seed | `aiops/graph.service.ts` |
| Walk / sharePath / commonCover (RCA topológica) | `aiops/graph-walk.ts` (+ `graph-walk.spec.ts`) |
| Ejemplo de grafo | `aiops/graph-example.ts` |

### Correlación e incidentes (MVP)

| Capacidad | Path |
|---|---|
| Clustering por sitio + ventana 5m + hops 4 | `aiops/correlation.service.ts` |
| `clusterKey` SHA-256 de fingerprints | mismo |
| Causa probable (`commonCover`), confidence heurística | mismo |
| API list/get/correlate + graph | `aiops/incidents.controller.ts` |
| Modelo `Incident` + enum status | `prisma/schema.prisma` |
| Módulo Nest | `aiops/incidents.module.ts` |

### Observabilidad y alertas

| Capacidad | Path |
|---|---|
| Flujo OTLP documentado | `ekumetrics-platform/docs/architecture.md` |
| Alertmanager overview / labels | `alertmanager/alertmanager.service.ts` |
| Canales email/slack/webhook | `alertmanager/alert-channels.service.ts` |
| Métricas HTTP + heartbeat agentes | `observability/metrics.service.ts` |

### Capa LLM / retrieval (reutilizar como tools de AIOps Agents; no como cerebro)

| Capacidad | Path |
|---|---|
| Catálogo de providers | `ai/ai.catalog.ts`, `ai/ai.providers.ts` |
| Chat + Holmes transport | `ai/ai.service.ts` |
| Retrieval tipado (métricas, anomalías z-score, logs, trazas, deps, eventos, incidentes) | `ai/retrieval.service.ts` |
| Prompt de producto / redacción | `ai/investigator-prompt.ts` |
| Retención conversaciones | `ai/ai-retention.service.ts` |
| RAG conocimiento aprobado | `ai/knowledge.service.ts` |
| Settings `AiSettings` | `prisma/schema.prisma` |
| Holmes k8s (toolsets peligrosos deshabilitados) | `infrastructure/k8s/config/holmes.yaml` |

### Portal

| Capacidad | Path |
|---|---|
| Lista/detalle + correlate | `portal-web/.../incidents/` (`/incidentes`) |
| Grafo + incidente (Cytoscape) | `portal-web/.../investigacion/` (`/investigacion`) |
| Árbol/topología helpers | `portal-web/.../correlacion/correlacion-tree.ts` |
| Asistente conversacional | `portal-web/.../holmes/` (`/asistente`) |
| Grafo compartido UI | `portal-web/.../shared/eku/cy-graph/` |

### Infra presente pero no cableada al AIOps

| Capacidad | Path | Nota |
|---|---|---|
| NATS + JetStream | `infrastructure/k8s/nats.yaml`, `nats-server.conf`, docker compose | Persistencia lista; **sin consumidores/productores de producto** |

---

## 3. Funcionalidad faltante (respecto al objetivo)

| Área | Gap |
|---|---|
| **EventBus abstracto** | No hay interfaz `EventBus` ni publicación de eventos de dominio (alerta, incidente, finding). NATS no está en el path de EKMS. |
| **NATS JetStream en pipeline** | Desplegado; no streams/subjects/consumers para ingestión ni correlación. |
| **Normalization layer** | Validación de contrato EKMS sí; no hay capa de normalización de identidad/entidad compartida alert↔asset↔node↔k8s. |
| **Correlation V1 configurable** | Ventana, hops y confidence **hardcoded**; no scores/política por tenant; no correlación continua (solo `POST correlate`). |
| **Incident Engine** | CRUD parcial vía correlate/list/get; **sin** máquina de estados DETECTED…CLOSED, transiciones API, assignee workflow, timeline, IncidentContext versionado. |
| **TopologyRepository** | `GraphService` cubre persistencia; falta abstracción de repositorio, tipos de relación ricos (RUNS_ON, DEPENDS_ON, …), sync CMDB↔grafo, TTL/stale. |
| **Anomaly Engine** | Solo `findMetricAnomalies` (z-score) dentro del asistente; no motor de anomalías que alimente correlación/incidentes. |
| **RcaAgent explicable** | Lógica embebida en `CorrelationService` (`commonCover`); no agente RCA independiente, no evidencia estructurada ni scorecard configurable. |
| **AgentOrchestrator + AIOps Agents** | Ausentes: selección por entityType, presupuesto, estados PENDING…TIMEOUT, Evidence Store, Synthesis Agent. |
| **Tool isolation por agente** | Retrieval es monolítico para el chat; no hay toolsets por tipo de AIOps Agent. |
| **AIProvider por agente/tenant** | Settings globales de asistente; no policy matrix AIOps (Metrics sin LLM, Synthesis con LLM, etc.). |
| **Privacy policies AIOps** | Redacción/retención del chat existen; faltan políticas de qué evidencia puede salir a cloud LLM por tenant/incidente. |
| **ITSM adapters** | No ServiceNow/Jira/etc.; webhooks de Alertmanager no son tickets de incidente. |
| **Remediación aprobada** | No modelo, API, ni agente de remediación. |
| **Métricas del propio AIOps** | Métricas de API/agentes recolectores; no counters de correlaciones, MTTD, hallazgos, presupuestos LLM, fallos de orquestación. |
| **UI Agents** | No pantalla de ejecuciones/findings de AIOps Agents. Topology está mezclada en investigación. |
| **RBAC `aiops.*`** | Solo roles `operator` / `admin` / `viewer` (y kiosk). |
| **Tests AIOps** | Solo `graph-walk.spec.ts`; sin tests de `CorrelationService` / ciclo de incidente / orquestador. |

---

## 4. Extender (no reescribir)

| Componente | Por qué extender |
|---|---|
| `CorrelationService` | Base V0 válida (fingerprint cluster, ventana, grafo). Extraer scores configurables, disparo continuo, separación de RCA. |
| `GraphService` + `GraphNode`/`GraphEdge` | Es el TopologyRepository de facto. Ampliar relaciones, queries y contrato; no crear segundo grafo. |
| `Incident` (Prisma) | Añadir estados/campos de contexto/investigaciones; no inventar otra entidad “ticket” paralela sin migrar. |
| `IngestService` | Punto natural para publicar al EventBus tras persistir; no reemplazar el contrato EKMS. |
| `RetrievalService` | Convertir operaciones tipadas en tools de Metrics/Logs/Topology agents; mantener catálogo cerrado. |
| `AiSettings` / `ai.catalog` | Reutilizar providers; añadir binding por agente AIOps y políticas de fallback offline. |
| `AlertChannelsService` | Patrón de canal cifrado reutilizable; ITSM puede seguir el mismo estilo de adapter, no mezclar alertas con tickets. |
| Portal `/incidentes` + `/investigacion` | Extender UX de estado, evidencia y findings; no crear una tercera pantalla “AIOps” genérica. |
| `AuditLog` | Extender acciones `aiops.*` (correlación, investigación, remediación). |
| Holmes config | Mantener toolsets peligrosos off; usar Holmes solo como backend del Kubernetes Agent si aplica. |

---

## 5. No duplicar

| Activo existente | Riesgo de duplicación |
|---|---|
| **Ekumetrics Agent** | No crear segundo recolector “AIOps collector”. |
| **Tenant / Site / Agent / actingTenant** | No segundo tenancy ni header paralelo. |
| **GraphNode / GraphEdge / GraphService** | No Neo4j/segundo grafo “CMDB AIOps” si el modelo actual cubre vecinos + kinds. |
| **Asset** | No segundo inventario; enriquecer Asset↔GraphNode. |
| **AgentEvent fingerprint** | No otro store de eventos crudos; normalizar hacia señales de correlación. |
| **Alertmanager + canales** | No segundo sistema de notificación de alertas; ITSM es capa distinta. |
| **Prometheus/Loki/Tempo** | No re-ingestar telemetría en Postgres para AIOps. |
| **EkuAssistant (`/asistente`)** | No convertirlo en orquestador de incidentes; es chat de operador. Reutilizar retrieval debajo. |
| **NATS como “otro Kafka de producto”** | Si se adopta EventBus, un solo backend (JetStream ya desplegado); no añadir bus paralelo. |

---

## 6. Tabla gap

| Capacidad | Hoy | Objetivo | Acción |
|---|---|---|---|
| Ekumetrics Agent (recolector) | Completo: OTLP + EKMS + discovery LLDP | Fuente de telemetría/discovery | **no duplicar** / reusar |
| Ingestión HTTP EKMS | `IngestService` con tenancy, fingerprint, assets, vecinos | Ingestion fiable | **reusar** / extender (emit EventBus) |
| EventBus abstracto | Ausente | Abstracción + impl JetStream | **crear** |
| NATS JetStream pipeline | Infra up; sin uso producto | Buffer/async entre capas | **extender** infra + **crear** producers/consumers |
| Normalization | Validación contrato + attrs OTel | Identidad canónica cross-source | **crear** (capa) / extender ingest |
| Observability stack | Prometheus/Loki/Tempo/Grafana | Consulta por agentes | **reusar** |
| CMDB (Asset) | Modelo + updates por señales | Inventario enlazado a topología | **extender** |
| Topology (`Graph*`) | GraphService + LLDP/example | TopologyRepository rico | **extender** / **no duplicar** |
| Correlation V1 | On-demand Alertmanager + grafo; scores fijos | Fingerprint + scores configurables + continuo | **extender** |
| Incident Engine | `Incident` open/ack/resolved/closed; sin transitions API | DETECTED…CLOSED + contexto | **extender** modelo + **crear** engine |
| Anomaly Engine | z-score en retrieval chat | Motor que alimente correlación | **crear** (puede basarse en retrieval) |
| RCA explicable | `commonCover` embebido en correlate | RcaAgent + evidencia | **extender** (extraer) → agente |
| AgentOrchestrator | Ausente | Selección, presupuesto, paralelo | **crear** |
| AIOps Agents (Metrics/Logs/K8s/Topology/Synthesis) | Chat monolítico Holmes+retrieval | Multi-agente evidence-first | **crear** (tools desde retrieval) |
| Tool isolation | Toolsets Holmes off; retrieval global al chat | Tools por agente | **crear** |
| AIProvider | Multi-provider asistente | Por tenant/agente + fallback sin LLM | **extender** |
| Privacy policies | Retención/redact chat/RAG | Políticas evidencia→LLM | **extender** / **crear** |
| ITSM adapters | No | Tickets desde incidente | **crear** |
| Remediación aprobada | No | Acciones allowlisted + approve | **crear** (fase posterior) |
| Métricas AIOps | HTTP + agent heartbeat | MTTD, hallazgos, budgets | **extender** `MetricsService` |
| UI Incidents | `/incidentes` lista + correlate | Operación completa de estados | **extender** |
| UI Topology | Embebida en `/investigacion` | Vista topología clara | **extender** (no segunda fuente) |
| UI Agents (investigación multi-agente) | Solo `/asistente` chat | Findings/ejecuciones por incidente | **crear** UI + API |
| RBAC `aiops.*` | Roles gruesos | Permisos finos | **extender** auth |
| Tests | `graph-walk` unitario | Correlation, engine, orchestrator | **crear** / extender cobertura |
| Degradación sin LLM | Correlación/grafo ya sin LLM | AIOps útil offline | **reusar** base; **crear** paths sin Synthesis LLM |

---

## 7. Riesgos arquitectónicos

1. **Holmes como cerebro implícito** — El portal y la docs de producto empujan investigación vía `/asistente`. Si se cablea el incidente solo a Holmes, se viola el objetivo (LLM ≠ correlación) y se pierde degradación graceful.
2. **NATS huérfano** — Infra promete JetStream; el path real es sync HTTP→Postgres. Riesgo de diseñar “EventBus” paralelo en memoria/Redis sin usar lo ya desplegado, o de sobre-ingenierizar JetStream antes de definir contratos de evento.
3. **Correlación solo Alertmanager** — `AgentEvent` y anomalías no alimentan incidentes. Doble verdad: alertas vs eventos del recolector.
4. **RCA mezclada con clustering** — `CorrelationService` hace cluster + causa + confidence. Dificulta tests, scores configurables y RcaAgent independiente.
5. **Estados de incidente incompletos** — Enum actual ≠ DETECTED…CLOSED; migrar mal puede romper portal/`RetrievalService` que filtra `open|acknowledged`.
6. **Grafo solo CONNECTS_TO** — Sin DEPENDS_ON / RUNS_ON, blast radius de apps/k8s será débil; tentación de segundo grafo.
7. **Confusión de producto “agente”** — UI/logs que digan “agent” para recolector e investigador generan deuda de nomenclatura (regla workspace).
8. **Remediación prematura** — Sin Evidence Store ni aprobación, cualquier webhook “auto-fix” es riesgo operativo/seguridad.
9. **RBAC grueso** — Operator puede correlate y ver grafo; sin `aiops.remediate` / `aiops.investigate` no hay separación de privilegios.
10. **Demo/seed en producción accidental** — `POST /graph/example` y demos en correlacion-page pueden contaminar topología real si no se aíslan.

---

## 8. Deuda técnica relevante

- Constantes mágicas en correlación: `WINDOW_MS = 5min`, `HOPS = 4`, confidence `0.25–0.91` sin política.
- Correlación **manual** (botón portal); no scheduler/consumer.
- Sin tests de `CorrelationService` / controller AIOps.
- `members` JSON libre en `Incident` — sin schema versionado de IncidentContext.
- Página `correlacion/` parcialmente legacy (redirect a investigación; demos aún en TS).
- `ai.service.ts` monolítico (~2.5k+ líneas): difícil reutilizar Synthesis sin acoplar al chat.
- NATS en compose/k8s sin owners de streams → coste operativo sin beneficio AIOps.
- Métricas AIOps inexistentes → no hay SLO de correlación/investigación.
- Enum `IncidentStatus` en minúsculas (`open`) vs objetivo en mayúsculas (`DETECTED`) — deuda de migración de contrato.

---

## 9. Lectura por capa (resumen ejecutivo)

| Capa objetivo | Madurez | Comentario |
|---|---|---|
| Ekumetrics Agent | Alta | No tocar como AIOps; ya alimenta eventos/topología |
| Ingestion | Media-alta | Sólida; falta async/EventBus |
| JetStream / EventBus | Baja (infra only) | Crear abstracción + cablear |
| Normalization | Baja | Solo validación |
| Observability | Alta | Reusar vía retrieval/tools |
| CMDB/Topology | Media | Graph+Asset listos para extender |
| Correlation | Media-baja (MVP) | Extender, no reescribir |
| Incident Engine | Baja-media | Modelo sí; engine no |
| RCA | Baja (embebida) | Extraer a RcaAgent |
| Multi-Agent | Muy baja | Crear Orchestrator; reusar retrieval |
| ITSM / Remediation | Nula | Crear después de evidencia |
| UI / RBAC / métricas AIOps | Parcial / nula | Extender portal; crear permisos y metrics |

**Principio guía:** el camino feliz sin LLM ya tiene semillas (ingesta → grafo → correlate → incidente). El mayor gap no es “otro recolector” ni “otro grafo”, sino **orquestación, motor de incidente, correlación continua/configurable y separación LLM como capa opcional**.

---

## 10. Resume para el orquestador (≤10 líneas)

1. Gap analysis en `docs/aiops/gap-analysis.md` (solo análisis; sin código de producto).  
2. Pipeline real: Agent→HTTP/OTLP→Postgres/Prom/Loki/Tempo; correlate on-demand desde Alertmanager; sin JetStream en path.  
3. Reusar: Agent, Ingest, GraphNode/Edge/GraphService, Incident MVP, Retrieval/AiSettings, portal incidentes/investigación.  
4. Extender: CorrelationService (scores/continuo), Incident model→engine, GraphService→TopologyRepository, MetricsService, RBAC.  
5. Crear: EventBus(+JetStream), Normalization, Anomaly→incident, RcaAgent, AgentOrchestrator, AIOps Agents, Evidence Store, ITSM, remediación (fase).  
6. No duplicar: recolector, tenancy, segundo grafo, segundo inventario, chat como orquestador.  
7. Riesgo #1: acoplar incidente a Holmes; riesgo #2: NATS huérfano o bus paralelo.  
8. Deuda: scores hardcoded, correlate manual, `members` JSON, tests AIOps mínimos, enum status vs DETECTED…CLOSED.  
9. LLM ya degradable en correlación/grafo; falta formalizar paths offline en investigación multi-agente.  
10. Siguiente paso lógico (fuera de este doc): diseño de contratos EventBus + IncidentContext + extracción RCA; no reescribir `aiops/` existente.
