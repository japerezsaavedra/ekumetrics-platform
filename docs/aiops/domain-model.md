# AIOps — Modelo de dominio (propuesta)

> **Estado:** diseño de dominio. Sin implementación Prisma/SQL ni cambios de producto.  
> **Alcance:** `platform-api` / portal. Distinguir siempre **Ekumetrics Agent** (recolector) ≠ **AIOps Agent** (investigación).  
> **Fuentes leídas:** `ekumetrics-platform/apps/platform-api/prisma/schema.prisma`, `src/aiops/`, reglas de nomenclatura y arquitectura multi-agent.

---

## 1. Principios

| Principio | Implicación |
|---|---|
| Multi-tenant estricto | `tenantId` en **todos** los modelos de dominio AIOps; índices compuestos siempre empiezan por `tenantId`. |
| Extender, no duplicar | `Incident`, `GraphNode`, `GraphEdge` ya existen → mapear/extender. No crear tablas paralelas `Entity`/`Relationship`/`IncidentV2` a ciegas. |
| Evidence-first | Findings y RCA llevan evidencia estructurada + confianza; nunca solo texto libre. |
| Nomenclatura | `AgentFinding.agentType` = tipo de **AIOps Agent** (`Rca`, `Metrics`, `Logs`, `Kubernetes`, `Topology`, `Synthesis`). El recolector es `collectorId` / FK a Prisma `Agent` cuando aplique. |
| Flujo | Telemetría → CanonicalEvent → correlación → IncidentCandidate → Incident → AIInvestigation → AgentFinding(s) → RootCauseCandidate → (ITSM / RemediationAction). |

---

## 2. Mapa Prisma actual → dominio AIOps

| Concepto dominio | Tabla Prisma actual | Estrategia |
|---|---|---|
| **Entity** | `GraphNode` | **Extender** `GraphNode` (o vista de dominio sobre ella). `nodeKey` ≈ `entityKey`. |
| **Relationship** | `GraphEdge` | **Extender** `GraphEdge`. Hoy `relation = CONNECTS_TO` (LLDP). Ampliar catálogo de relaciones. |
| **Incident** | `Incident` | **Extender** el modelo existente. Ampliar lifecycle; conservar campos de correlación (`clusterKey`, `causeKey`, `members`, …). |
| Inventario de activos | `Asset` | **Complementario.** Inventario del recolector; enlazar a Entity vía `assetKey` ↔ `nodeKey` / `entityKey` cuando coincidan. No sustituye al grafo. |
| Evento crudo del recolector | `AgentEvent` | **Fuente** de CanonicalEvent (señales/métricas). No es el evento canónico AIOps. |
| Registro del recolector | `Agent` | Solo Ekumetrics Agent. **No** es AIOps Agent. |
| Chat / Q&A | `AiConversation`, `AiInquiry` | Fuera del pipeline de investigación de incidentes. No confundir con `AIInvestigation`. |
| Auditoría genérica | `AuditLog` | Complementario; remediaciones e ITSM también dejan rastro propio. |

---

## 3. Modelos de dominio

Convenciones comunes:

- `id`: `cuid()` (string).
- `tenantId`: obligatorio; FK lógica a `Tenant`.
- `createdAt` / `updatedAt` donde haya mutación de estado.
- Campos JSON tipados en dominio (`evidence`, `members`, `budget`, …); en persistencia pueden ser `Json`.

---

### 3.1 CanonicalEvent

Evento normalizado del pipeline AIOps (alerta correlable, señal anómala, cambio, deploy, etc.). Unifica Alertmanager, `AgentEvent` y fuentes futuras.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | PK |
| `tenantId` | string | obligatorio |
| `fingerprint` | string | idempotencia / dedup (puede alinear con Alertmanager o hash de señal) |
| `siteId` | string? | |
| `entityKey` | string? | clave de Entity / `GraphNode.nodeKey` resuelta o hint |
| `source` | string | `alertmanager` \| `agent_event` \| `k8s` \| `change` \| … |
| `sourceRef` | string? | id externo o FK lógica (`AgentEvent.id`, fingerprint AM, …) |
| `collectorId` | string? | Prisma `Agent.id` si viene del recolector (**no** AIOps Agent) |
| `kind` | string | `ALERT` \| `METRIC_SIGNAL` \| `LOG_SIGNAL` \| `CHANGE` \| `DEPLOY` \| … |
| `name` | string | título / rule / señal |
| `severity` | string | `critical` \| `error` \| `warning` \| `info` \| … |
| `status` | enum | ver abajo |
| `value` | float? | |
| `unit` | string? | |
| `labels` | Json | tags / labels originales |
| `payload` | Json? | cuerpo normalizado |
| `occurredAt` | DateTime | momento del evento en origen |
| `receivedAt` | DateTime | ingreso a plataforma |
| `incidentCandidateId` | string? | tras clustering |
| `incidentId` | string? | tras promoción |

**Estados:** `RAW` → `NORMALIZED` → `CORRELATED` → `SUPERSEDED` \| `EXPIRED`.

**Índices:**  
`(tenantId, fingerprint)` unique · `(tenantId, occurredAt)` · `(tenantId, entityKey, occurredAt)` · `(tenantId, siteId, occurredAt)` · `(tenantId, status)` · `(tenantId, incidentId)`.

**Relaciones:** N:1 Tenant; 0..1 Entity (`entityKey`); 0..1 IncidentCandidate; 0..1 Incident; opcional 0..1 `AgentEvent` / alert externa vía `sourceRef`.

**Restricciones:** `fingerprint` único por tenant; no cruzar tenants; `occurredAt` requerido.

**Mapeo Prisma:** **tabla nueva** `CanonicalEvent`. Ingesta desde Alertmanager (hoy en `CorrelationService.fromManaged`) y proyección/batch desde `AgentEvent`. No reemplaza `AgentEvent` (retención/telemetría cruda).

---

### 3.2 Entity

Nodo canónico de topología / CMDB liviana para blast radius y RCA.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | = `GraphNode.id` si se reutiliza la tabla |
| `tenantId` | string | |
| `siteId` | string | hoy obligatorio en `GraphNode` |
| `entityKey` | string | = `GraphNode.nodeKey` |
| `kind` / `entityType` | string | `device`, `K8S_POD`, `DEPLOYMENT`, `NODE`, `service`, … (selector de AIOps Agents) |
| `name` | string | |
| `source` | string | `lldp`, `example`, `k8s`, `snmp`, … |
| `status` | string? | opcional futuro: `active` \| `stale` \| `retired` |
| `attributes` | Json? | **extensión propuesta** (labels, IP, namespace, …) |
| `assetId` | string? | **extensión propuesta** → `Asset` |
| `lastSeenAt` | DateTime | |
| `createdAt` / `updatedAt` | DateTime | |

**Estados (opcionales):** `ACTIVE` \| `STALE` \| `RETIRED` (derivables de `lastSeenAt` si no se persiste).

**Índices (ya / propuestos):**  
`@@unique([tenantId, nodeKey])` · `(tenantId, siteId)` · `(tenantId, lastSeenAt)` · propuesto `(tenantId, kind)`.

**Relaciones:** N:1 Tenant; 0..1 Asset; edges salientes/entrantes vía Relationship; referenciada por eventos, incidentes (`causeKey`), findings.

**Restricciones:** `entityKey` único por tenant; `siteId` coherente con Site del tenant.

**Mapeo Prisma:** **`GraphNode` ≈ Entity.** No crear `Entity` duplicada. Extender columnas (`attributes`, `assetId`, quizá renombrar semántico en capa de dominio solo). Código actual: `GraphService.touchNode` / `upsertNeighbor`.

---

### 3.3 Relationship

Arista tipada entre Entities.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | = `GraphEdge.id` |
| `tenantId` | string | |
| `siteId` | string | |
| `fromKey` | string | entityKey origen |
| `toKey` | string | entityKey destino |
| `relation` | string | ver catálogo |
| `source` | string | procedencia del hecho |
| `weight` | float? | **extensión** (scoring RCA) |
| `attributes` | Json? | **extensión** |
| `lastSeenAt` | DateTime | |
| `createdAt` / `updatedAt` | DateTime | |

**Catálogo `relation` (evolutivo):**

| Valor | Uso |
|---|---|
| `CONNECTS_TO` | L2/LLDP (ya en producción) |
| `RUNS_ON` | pod → node, proceso → host |
| `DEPENDS_ON` | servicio → dependencia |
| `ROUTES_TO` / `CONTAINS` | fases posteriores |

**Estados:** implícitos por frescura (`lastSeenAt`); opcional `ACTIVE` \| `STALE`.

**Índices (ya):**  
`@@unique([tenantId, fromKey, toKey, relation, source])` · `(tenantId, siteId)` · `(tenantId, fromKey)` · `(tenantId, toKey)`.

**Relaciones:** endpoints lógicos a Entity por `(tenantId, fromKey|toKey)`; hoy **sin** FK Prisma a `GraphNode` (mantener o añadir FKs en migración futura).

**Restricciones:** no edges cross-tenant; uniqueness cuádruple actual.

**Mapeo Prisma:** **`GraphEdge` ≈ Relationship.** Extender tipos de `relation` y columnas opcionales. Hoy solo se escribe `CONNECTS_TO`.

---

### 3.4 IncidentCandidate

Cluster preliminar de CanonicalEvents **antes** de promover a Incident. Permite umbrales, cool-down y rechazo sin ensuciar la cola operativa.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | |
| `tenantId` | string | |
| `siteId` | string? | |
| `clusterKey` | string | hash estable (mismo algoritmo que hoy en `CorrelationService.persist`) |
| `status` | enum | ver abajo |
| `severity` | string | peor del cluster |
| `windowStart` / `windowEnd` | DateTime? | |
| `entityKeys` | Json / string[] | nodos implicados |
| `eventFingerprints` | Json / string[] | |
| `eventCount` / `alertCount` | int | |
| `suggestedCauseKey` | string? | `commonCover` preliminar |
| `confidence` | float? | |
| `promotedIncidentId` | string? | si se promociona |
| `reason` | string? | por qué se abrió / descartó |
| `createdAt` / `updatedAt` | DateTime | |

**Estados:** `OPEN` → `PROMOTING` → `PROMOTED` \| `DISCARDED` \| `MERGED` \| `EXPIRED`.

**Índices:**  
`(tenantId, clusterKey, status)` · `(tenantId, status, updatedAt)` · `(tenantId, siteId, windowStart)`.

**Relaciones:** N CanonicalEvents; 0..1 Incident (`promotedIncidentId`).

**Restricciones:** un candidate `OPEN` por `(tenantId, clusterKey)` a la vez; promoción atómica a Incident.

**Mapeo Prisma:** **tabla nueva.** Hoy la correlación escribe directo en `Incident` (`CorrelationService.merge` / `persist`). Extraer esa etapa intermedia sin cambiar el hash de `clusterKey` para no romper dedup.

---

### 3.5 Incident

Incidente operativo + contenedor de investigación AIOps. **Reutilizar y extender** el modelo Prisma `Incident`.

#### Campos actuales (reutilizar)

| Campo Prisma | Rol en dominio |
|---|---|
| `id`, `tenantId` | identidad |
| `assetId`, `assigneeId` | enlace inventario / operador |
| `title`, `severity` | presentación |
| `status` | lifecycle (ver mapeo abajo) |
| `siteId` | alcance |
| `clusterKey` | dedup de correlación |
| `causeKey`, `causeName`, `confidence` | causa preliminar **determinista** (grafo); coexisten con RootCauseCandidate |
| `windowStart`, `windowEnd` | ventana temporal |
| `alertCount`, `eventCount` | contadores |
| `members` | Json: alerts + impact (hoy) |
| `createdAt`, `updatedAt` | auditoría |

#### Campos de extensión propuestos

| Campo | Tipo | Notas |
|---|---|---|
| `lifecycleStatus` | enum AIOps | ver §3.5.1 — **recomendado** si se conserva `status` legacy en UI |
| *o* ampliar `IncidentStatus` | enum unificado | migración de valores + compat API |
| `primaryEntityKey` | string? | entidad foco (= `causeKey` inicial o override) |
| `context` | Json? | `IncidentContext` para el orquestador |
| `promotedFromCandidateId` | string? | |
| `resolvedAt` / `closedAt` | DateTime? | |
| `resolutionNote` | string? | |

#### 3.5.1 Estados objetivo vs enum Prisma actual

**Prisma hoy:** `open` \| `acknowledged` \| `resolved` \| `closed`.

**Objetivo AIOps:**

| Estado objetivo | Significado | Encaje con enum actual |
|---|---|---|
| `DETECTED` | incidente creado / promovido | ≈ `open` |
| `CORRELATING` | enriqueciendo cluster / miembros | ≈ `open` (subfase) |
| `INVESTIGATING` | `AIInvestigation` en curso | ≈ `open` o `acknowledged` |
| `ROOT_CAUSE_IDENTIFIED` | RCA aceptada o confidence alta | ≈ `acknowledged` |
| `MITIGATING` | remediación / cambio en curso | ≈ `acknowledged` |
| `RESOLVED` | impacto mitigado | = `resolved` |
| `CLOSED` | cerrado operativo | = `closed` |

**Estrategia recomendada (diseño):**

1. **Corto plazo:** mantener `Incident.status` (`open`…`closed`) para API/UI existentes; añadir `lifecycleStatus` (enum AIOps) con default `DETECTED` cuando `status=open`.
2. **Medio plazo:** unificar en un solo enum ampliado y deprecar el de 4 valores; mapear lecturas antiguas:
   - `open` → `DETECTED` \| `CORRELATING` \| `INVESTIGATING`
   - `acknowledged` → `ROOT_CAUSE_IDENTIFIED` \| `MITIGATING` (o `INVESTIGATING` si solo ack manual)
   - `resolved` / `closed` → iguales.

**Índices (ya + propuestos):**  
`(tenantId, clusterKey)` · `(tenantId)` · `(status)` · `(assetId)` · `(siteId)` · propuesto `(tenantId, lifecycleStatus, updatedAt)` · `(tenantId, status)` compuesto.

**Relaciones:** Tenant; Asset?; User assignee?; CanonicalEvents; AgentFindings; AIInvestigations; RootCauseCandidates; ExternalTicketLinks; RemediationActions; Entity vía `causeKey` / `primaryEntityKey`.

**Restricciones:** correlación actual solo upserta si `status ∈ {open, acknowledged}` — al ampliar lifecycle, incluir `DETECTED`…`MITIGATING` (o los mapeados a “abiertos”). Un incidente “activo” por `clusterKey` a la vez.

**Mapeo Prisma:** **mismo modelo `Incident`.** No tabla nueva.

---

### 3.6 RootCauseCandidate

Hipótesis de causa raíz (determinista o por síntesis). Separa el snapshot `causeKey`/`causeName` del incidente de la lista versionada de hipótesis.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | |
| `tenantId` | string | |
| `incidentId` | string | |
| `investigationId` | string? | `AIInvestigation` que la produjo |
| `rank` | int | 1 = más probable |
| `entityKey` | string? | Entity sospechosa |
| `hypothesis` | string | enunciado |
| `confidence` | float | 0..1 |
| `status` | enum | ver abajo |
| `evidence` | Json | refs a findings / eventos / edges |
| `source` | string | `deterministic_rca` \| `synthesis` \| `operator` |
| `findingIds` | Json / string[] | |
| `createdAt` / `updatedAt` | DateTime | |
| `acceptedAt` / `rejectedAt` | DateTime? | |
| `acceptedBy` | string? | actor |

**Estados:** `PROPOSED` → `ACCEPTED` \| `REJECTED` \| `SUPERSEDED`.

**Índices:** `(tenantId, incidentId, rank)` · `(tenantId, incidentId, status)` · `(tenantId, entityKey)`.

**Relaciones:** N:1 Incident; 0..1 AIInvestigation; N AgentFindings (lógico); Entity opcional.

**Restricciones:** a lo sumo **un** `ACCEPTED` por incidente a la vez; al aceptar → Incident `lifecycleStatus = ROOT_CAUSE_IDENTIFIED` y opcional sync de `causeKey`/`causeName`/`confidence`.

**Mapeo Prisma:** **tabla nueva.** Los campos `Incident.causeKey|causeName|confidence` quedan como **caché de la causa aceptada o de la RCA determinista inicial** (compat con UI/correlación actual).

---

### 3.7 AgentFinding

Resultado de **un** AIOps Agent en el contexto de un incidente / investigación.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | |
| `tenantId` | string | |
| `incidentId` | string | |
| `investigationId` | string? | |
| `agentType` | string | `Rca` \| `Metrics` \| `Logs` \| `Kubernetes` \| `Topology` \| `Synthesis` \| … (**AIOps**, no recolector) |
| `status` | enum | `PENDING` \| `RUNNING` \| `WAITING` \| `COMPLETED` \| `FAILED` \| `SKIPPED` \| `TIMEOUT` |
| `summary` | string | conclusión breve |
| `evidence` | Json | facts, queries, snippets, nodeKeys, series — evidence-first |
| `confidence` | float? | |
| `startedAt` | DateTime? | |
| `completedAt` | DateTime? | |
| `provider` | string? | backend LLM/tool (`local`, `holmes`, `qwen`, …) |
| `model` | string? | |
| `toolCalls` | Json? | lista acotada de tools invocadas |
| `errors` | Json? | errores / timeouts parciales |
| `createdAt` / `updatedAt` | DateTime | |

**Transiciones de estado:**

```
PENDING → RUNNING → WAITING → RUNNING → COMPLETED
                 ↘ FAILED | TIMEOUT
PENDING → SKIPPED   (política de selección / presupuesto)
```

**Índices:** `(tenantId, incidentId, agentType)` · `(tenantId, investigationId)` · `(tenantId, status, updatedAt)` · `(tenantId, incidentId, createdAt)`.

**Relaciones:** N:1 Incident; 0..1 AIInvestigation; alimenta RootCauseCandidate / síntesis.

**Restricciones:** aislamiento por tenant; sin shell arbitrario en `toolCalls`; presupuesto de investigación limita creación/ejecución.

**Mapeo Prisma:** **tabla nueva.** No existe hoy. No confundir con `AiInquiry` (chat).

---

### 3.8 AIInvestigation

Ejecución orquestada (corrida) del `AgentOrchestrator` sobre un Incident.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | |
| `tenantId` | string | |
| `incidentId` | string | |
| `status` | enum | ver abajo |
| `trigger` | string | `auto` \| `operator` \| `reopen` |
| `selectedAgents` | Json / string[] | agentTypes elegidos |
| `budget` | Json | `maxAgents`, `maxToolCalls`, `maxLLMCalls`, `maxTokens`, `maxDuration` |
| `budgetUsed` | Json? | contadores reales |
| `synthesisSummary` | string? | salida del Synthesis Agent |
| `synthesisEvidence` | Json? | |
| `primaryFindingId` | string? | |
| `startedAt` / `completedAt` | DateTime? | |
| `createdAt` / `updatedAt` | DateTime | |
| `createdBy` | string? | actor o `system` |

**Estados:** `QUEUED` → `RUNNING` → `SYNTHESIZING` → `COMPLETED` \| `FAILED` \| `CANCELLED` \| `BUDGET_EXCEEDED`.

**Índices:** `(tenantId, incidentId, createdAt)` · `(tenantId, status)` · único parcial opcional: una investigación `RUNNING` por incidente.

**Relaciones:** N:1 Incident; 1:N AgentFinding; 1:N RootCauseCandidate; puede disparar RemediationAction / ExternalTicketLink.

**Restricciones:** el orquestador **no** embebe lógica de dominio; solo selección, paralelismo, timeouts y persistencia. HolmesGPT (u otro) es provider de tools de un agente, no orquestador.

**Mapeo Prisma:** **tabla nueva.**

---

### 3.9 ExternalTicketLink

Vínculo a ITSM / tracker externo (ServiceNow, Jira, etc.).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | |
| `tenantId` | string | |
| `incidentId` | string | |
| `provider` | string | `servicenow` \| `jira` \| `webhook` \| … |
| `externalId` | string | clave del ticket |
| `externalUrl` | string? | |
| `status` | enum | `LINKED` \| `SYNCING` \| `SYNCED` \| `FAILED` \| `UNLINKED` |
| `syncDirection` | string | `outbound` \| `inbound` \| `bidirectional` |
| `lastSyncAt` | DateTime? | |
| `payload` | Json? | snapshot / mapping |
| `createdAt` / `updatedAt` | DateTime | |

**Índices:** `@@unique([tenantId, provider, externalId])` · `(tenantId, incidentId)` · `(tenantId, status)`.

**Relaciones:** N:1 Incident; adaptador `ITSMAdapter`.

**Restricciones:** un mismo ticket externo no se enlaza a dos incidentes del mismo tenant sin `UNLINK` previo (unique).

**Mapeo Prisma:** **tabla nueva.**

---

### 3.10 RemediationAction

Acción de remediación **aprobada** (agente de remediación distinto del de investigación).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | |
| `tenantId` | string | |
| `incidentId` | string | |
| `investigationId` | string? | |
| `rootCauseCandidateId` | string? | |
| `actionType` | string | catálogo cerrado: `restart_deployment`, `scale`, `webhook`, `runbook`, … |
| `targetEntityKey` | string? | |
| `params` | Json | parámetros tipados por `actionType` |
| `status` | enum | ver abajo |
| `requestedBy` | string | |
| `approvedBy` | string? | obligatorio antes de ejecutar |
| `approvedAt` | DateTime? | |
| `executedAt` / `verifiedAt` | DateTime? | |
| `result` | Json? | salida / verificación |
| `error` | string? | |
| `createdAt` / `updatedAt` | DateTime | |

**Estados:** `PROPOSED` → `PENDING_APPROVAL` → `APPROVED` → `EXECUTING` → `VERIFYING` → `SUCCEEDED` \| `FAILED` → (opcional) `ROLLED_BACK`.  
También: `REJECTED` \| `CANCELLED` desde aprobación.

**Índices:** `(tenantId, incidentId, status)` · `(tenantId, actionType, createdAt)` · `(tenantId, targetEntityKey)`.

**Relaciones:** N:1 Incident; 0..1 AIInvestigation; 0..1 RootCauseCandidate; Entity objetivo.

**Restricciones:** **prohibido** comando arbitrario / shell libre; solo `actionType` del catálogo; ejecución solo con `APPROVED`; auditoría (propia + `AuditLog`).

**Mapeo Prisma:** **tabla nueva.** Fase 3 según arquitectura; el modelo se declara ya para no romper el flujo RCA → recomendación → aprobación → remediar → verificar.

---

## 4. Diagrama de relaciones (lógico)

```
Tenant
  ├── GraphNode (Entity)
  ├── GraphEdge (Relationship) ── CONNECTS_TO | RUNS_ON | …
  ├── AgentEvent ──(proyecta)──► CanonicalEvent ──► IncidentCandidate ──promueve──► Incident
  │                                                      │
  │                                                      ├── AIInvestigation
  │                                                      │     └── AgentFinding (AIOps Agents)
  │                                                      ├── RootCauseCandidate
  │                                                      ├── ExternalTicketLink
  │                                                      └── RemediationAction
  ├── Asset (inventario; enlace opcional a Entity)
  └── Agent (Ekumetrics Agent / recolector)
```

---

## 5. Conflictos y decisiones abiertas

### 5.1 Incident: dos ejes de estado

- UI/API actuales asumen `open|acknowledged|resolved|closed`.
- El pipeline AIOps necesita subfases (`CORRELATING`, `INVESTIGATING`, …).
- **Decisión de diseño:** `lifecycleStatus` nuevo + `status` legacy; unificación posterior. Evitar romper `CorrelationService` que filtra `open`/`acknowledged`.

### 5.2 Causa en Incident vs RootCauseCandidate

- Hoy `causeKey`/`causeName`/`confidence` son la RCA determinista del grafo.
- Con hipótesis múltiples, esos campos son **caché** de la aceptada / preliminar; la verdad versionada vive en `RootCauseCandidate`.

### 5.3 Entity/Relationship vs tablas nuevas

- Duplicar `Entity`/`Relationship` rompería `GraphService`, correlación e impacto.
- Extender `GraphNode`/`GraphEdge` y exponer puertos de dominio (`TopologyRepository`) sobre las mismas tablas.

### 5.4 CanonicalEvent vs AgentEvent

- `AgentEvent`: telemetría cruda del recolector (volume/retention).
- `CanonicalEvent`: unidad de correlación AIOps (alerts + señales seleccionadas + changes).
- No fusionar tablas; sí proyección explícita.

### 5.5 AgentFinding vs AiInquiry

- `AiInquiry`: chat asistente.
- `AgentFinding`: evidencia de investigación de incidente.
- Persistencia y APIs separadas.

### 5.6 Nombre `Agent` en Prisma

- Modelo Prisma `Agent` = Ekumetrics Agent.
- En código AIOps usar `collectorId` / `CollectorRef`, nunca “agent” ambiguo para findings.

---

## 6. Migrations propuestas (lista, no SQL)

Orden sugerido; cada ítem es una migración lógica (puede agruparse en PRs):

1. **Extend `GraphNode`:** columnas opcionales `attributes Json?`, `assetId String?` (+ índice `tenantId, kind` si no existe vía query).
2. **Extend `GraphEdge`:** `weight Float?`, `attributes Json?`; documentar nuevos valores de `relation` (sin enum rígido al inicio).
3. **Extend `Incident`:** `lifecycleStatus` (enum nuevo o string acotado), `primaryEntityKey`, `context Json?`, `promotedFromCandidateId`, `resolvedAt`, `closedAt`, `resolutionNote`; índices `(tenantId, lifecycleStatus, updatedAt)`.
4. **Create `CanonicalEvent`** (+ uniques/índices §3.1); FK lógicas a tenant; opcional backfill desde alertas recientes (no obligatorio en MVP).
5. **Create `IncidentCandidate`** (+ índices §3.4).
6. **Create `AIInvestigation`** (+ índices §3.8).
7. **Create `AgentFinding`** (+ índices §3.7; FK a Incident / Investigation).
8. **Create `RootCauseCandidate`** (+ índices §3.6; regla de un `ACCEPTED` por incidente a nivel app o índice parcial único).
9. **Create `ExternalTicketLink`** (+ unique provider/externalId).
10. **Create `RemediationAction`** (+ índices §3.10).
11. **(Opcional, posterior)** Unificar `IncidentStatus` al enum AIOps completo y migración de datos `open→DETECTED`, etc.; deprecar `lifecycleStatus` duplicado.
12. **(Opcional)** FK Prisma `GraphEdge.fromKey/toKey` → `GraphNode.nodeKey` (hoy solo lógico).

> No se ejecuta SQL en este documento. No se toca el schema de producto hasta aprobación explícita.

---

## 7. Interfaces nuevas (puertos de dominio)

Solo nombres y responsabilidad; sin implementación.

| Interfaz | Responsabilidad |
|---|---|
| `TopologyRepository` | Leer/escribir Entity/Relationship sobre `GraphNode`/`GraphEdge`; impact walk; match por hint; neighbors. Sustituye acoplamiento directo de correlación a Prisma graph. |
| `EventBus` | Publicar/consumir hechos de dominio (`CanonicalEventNormalized`, `IncidentPromoted`, `InvestigationCompleted`, `RemediationApproved`, …) dentro de la plataforma. |
| `AIProvider` | Abstracción de LLM/tool-backend **por tenant y por agentType** (local, Holmes, Qwen, Grok, Claude…). Usado por AIOps Agents; no orquesta. |
| `ITSMAdapter` | Crear/actualizar/enlazar tickets externos; implementaciones por `provider` detrás de `ExternalTicketLink`. |

Puertos relacionados (nombres, no obligatorios en MVP de persistencia):

| Interfaz | Notas |
|---|---|
| `CanonicalEventStore` | Persistencia / query de CanonicalEvent |
| `IncidentRepository` | Extiende acceso actual a `Incident` + candidates |
| `InvestigationRepository` | AIInvestigation + AgentFinding + presupuesto |
| `EvidenceStore` | Append/query de evidence de findings (puede ser fachada sobre `AgentFinding.evidence`) |
| `RemediationGateway` | Ejecuta solo acciones aprobadas del catálogo |

---

## 8. Resumen ejecutivo (≈10 líneas)

1. Se **reutiliza** Prisma `Incident`, `GraphNode`, `GraphEdge` (y de apoyo `Asset`, `AgentEvent`, `Agent` recolector, `Tenant`, `Site`, `User`).  
2. **`GraphNode` ≈ Entity**; **`GraphEdge` ≈ Relationship** (hoy `CONNECTS_TO`); se extienden columnas/tipos, no se duplican tablas.  
3. **`Incident` se extiende** con lifecycle AIOps; el enum actual `open|acknowledged|resolved|closed` se mapea a `DETECTED…CLOSED` vía `lifecycleStatus` o unificación posterior.  
4. **Tablas nuevas:** `CanonicalEvent`, `IncidentCandidate`, `AIInvestigation`, `AgentFinding`, `RootCauseCandidate`, `ExternalTicketLink`, `RemediationAction`.  
5. `AgentEvent` permanece como telemetría cruda; alimenta `CanonicalEvent`, no lo reemplaza.  
6. `causeKey`/`causeName` en Incident conviven como caché; la verdad versionada es `RootCauseCandidate`.  
7. Conflicto principal: **estados de Incident** (4 valores ops vs 7 de pipeline) — dual-field al inicio.  
8. Conflicto secundario: correlación **escribe Incident directo**; falta la etapa `IncidentCandidate`.  
9. `AgentFinding` es de **AIOps Agents**; no usar el modelo Prisma `Agent` ni `AiInquiry`.  
10. Puertos nuevos: `TopologyRepository`, `EventBus`, `AIProvider`, `ITSMAdapter` (más stores opcionales).
