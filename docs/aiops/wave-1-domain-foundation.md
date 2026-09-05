# Wave 1 — AIOps Domain Foundation

Fundación de dominio RCA / investigación multi-agente en `platform-api`. **No** hay loop de ejecución, **no** hay conexión a LLM y **no** se usa Holmes como orquestador.

Nomenclatura: **Ekumetrics Agent** = recolector (`ekumetrics-agent/`). **AIOps Agent** = investigador lógico (`RcaAgent`, `MetricsAgent`, `AgentOrchestrator`).

## Qué se persiste vs qué es transitorio

| Entidad | Persistencia | Por qué |
|---|---|---|
| **AgentFinding** | Tabla Prisma `AgentFinding` | Auditoría de cada corrida de un AIOps Agent: estado, evidencia, provider/model, toolCalls, errores. Sobrevive al proceso y aísla tenant. |
| **AiopsInvestigation** | Tabla Prisma `AiopsInvestigation` | Corrida del orquestador (presupuesto, agentes elegidos, síntesis). Incluye `incidentLifecycle` opcional para el pipeline AIOps. |
| **RootCauseCandidate** | Transitorio (tipos TS) | Hipótesis versionada; en wave 1 no hay aceptación operativa ni UI. `Incident.causeKey` sigue siendo la caché de correlación. |
| **RcaEvidence** | Transitorio | Viaja dentro del candidato o se copia a `AgentFinding.evidence` (JSON). No merece tabla propia todavía. |
| **IncidentContext** | Transitorio | Input del orquestador; no reemplaza `Incident.members`. |
| **InvestigationBudget** | JSON en Investigation | Tipo de dominio; se guarda como Json en la fila persistida. |

No se crearon `CanonicalEvent`, `IncidentCandidate`, `ExternalTicketLink` ni `RemediationAction` (fuera de wave 1).

## Incident.status vs lifecycle AIOps

`Incident.status` **no se tocó**: `open` \| `acknowledged` \| `resolved` \| `closed`.

El lifecycle AIOps (`DETECTED` … `CLOSED`) vive en `AiopsInvestigation.incidentLifecycle` (opcional). Mapeo de lectura:

| Incident.status | Lifecycle | Inverso (solo lectura) |
|---|---|---|
| open | DETECTED | DETECTED, CORRELATING, INVESTIGATING → open |
| acknowledged | INVESTIGATING | ROOT_CAUSE_IDENTIFIED, MITIGATING → acknowledged |
| resolved | RESOLVED | RESOLVED → resolved |
| closed | CLOSED | CLOSED → closed |

Aceptar una hipótesis RCA **no** escribe `Incident.status`.

## Modelos Prisma (solo al final de `schema.prisma`)

Sin editar `AgentEvent`, `GraphNode`, `GraphEdge` ni `Incident`. Relación Prisma a `Tenant` (cascade) + `tenantId` en cada fila. `incidentId` es FK lógica a `Incident` (sin relación Prisma para no mutar ese modelo).

Relación nueva: `AgentFinding.investigationId` → `AiopsInvestigation` (cascade).

Índices: todos empiezan por `tenantId`.

Migración: `apps/platform-api/prisma/migrations/20260904123000_aiops_domain_foundation/`.

## Interfaces (puertos)

| Interfaz | Token Nest | Responsabilidad wave 1 |
|---|---|---|
| `RcaEngine` | `RcaEngine` | `propose()` → hipótesis. Stub: lista vacía. |
| `AiopsAgent` | — | Contrato de investigador (`agentType` + `investigate`). Stub: `RcaAgentStub` → `SKIPPED`. |
| `AgentOrchestrator` | `AgentOrchestrator` | `select` aplica política (Rca siempre; K8s/Metrics/Logs/Topology según contexto). `run` **no** despacha el loop: devuelve `QUEUED` en memoria. |

Stubs en `src/aiops/stubs/`. Logs en texto plano, sin iconos.

Tipos en `src/aiops/types/` (no en `shared-contracts`).

## Fuera de alcance (explícito)

- Loop multi-agente, ejecución real de presupuesto, Synthesis Agent
- LLM / Holmes / EkuAssistant como cerebro
- `messaging/`, `CorrelationService`, `GraphService`, ingest, portal, `shared-contracts`
- Cambiar enum o filas de `Incident`

## Tests

- `src/aiops/types/rca-domain.spec.ts` — evidencia, confidence, un ACCEPTED, mapeo lifecycle, transiciones de finding, `agentType` ≠ recolector, política `select`
- `src/aiops/persistence/agent-finding.repository.spec.ts` — aislamiento tenant (Prisma mock)
- `src/aiops/persistence/investigation.repository.spec.ts` — aislamiento tenant de Investigation
- `src/aiops/stubs/aiops-stubs.spec.ts` — stubs sin LLM / sin loop

## Cómo probar

Desde `ekumetrics-platform/apps/platform-api`:

```
npx prisma generate
npx jest src/aiops/types/rca-domain.spec.ts src/aiops/persistence src/aiops/stubs
```

## Archivos

```
ekumetrics-platform/apps/platform-api/src/aiops/
  types/          # RootCauseCandidate, RcaEvidence, AgentFinding, AiopsInvestigation
  interfaces/     # RcaEngine, AiopsAgent, AgentOrchestrator
  stubs/
  persistence/    # AgentFindingRepository, InvestigationRepository
  aiops-domain.module.ts
docs/aiops/wave-1-domain-foundation.md
```

## Limitaciones

- `RcaEngine` no extrae causa del grafo; CorrelationService sigue escribiendo `Incident.cause*`.
- `run()` del orquestador no persiste ni llama AIOps Agents.
- RootCauseCandidate no tiene tabla; persistir hipótesis queda para una wave posterior.
