# Wave 2 — Task 3: Topology correlation

Extensión topológica de **CorrelationService V2**. No reemplaza el motor de correlación, ni `TopologyRepository` / `GraphService` / `GraphNode` / `GraphEdge` de Wave 1.

**Nomenclatura:** Ekumetrics Agent = recolector. Aquí no hay AIOps Agent ni `AgentOrchestrator`.

## Cómo se extiende CorrelationService V2 (no se sustituye)

1. V2 sigue agrupando por sitio + ventana + `sharePath` (`graph-walk.ts`).
2. Si existe `TopologyCorrelationService`, `merge()` llama `apply()` **después** del clustering V1/V2.
3. `apply()` puede **unir clusters** cuando un ancestro común con confianza suficiente indica una sola causa (supresión configurable).
4. `persist()` adjunta de forma aditiva `members.blastRadius`, `members.suppression` y `members.topologyEvidence`. El score V2 (`members.correlation`) se recalcula solo en el componente `topologyScore` cuando hay pares de nodos.
5. Sin `TopologyCorrelationService` inyectado, el comportamiento V2 no cambia.

```text
Alertmanager → CorrelationService.cluster (V2)
            → TopologyCorrelationService.apply (Wave 2)
            → persist Incident + publish EventSubjects.EVENTS_CORRELATED
```

No hay subjects nuevos. Se reutiliza `ekumetrics.events.correlated` con payload aditivo (`tenantId`, `blastRadius`, `suppression`, `topologyEvidence`).

## Capacidades

| Capacidad | Implementación |
|---|---|
| Ancestro común | `TopologyRepository.getCommonAncestor` (dirigido; fallback `commonCover` LLDP) |
| Score aguas arriba | Dirección `upstream` (A `DEPENDS_ON`/`RUNS_ON` B) + distancia |
| Blast radius | Directos + indirectos + services + applications |
| Score de camino | Dirección × distancia × confianza de relación |
| Supresión de causa raíz | Une clusters; no oculta síntomas (`evidenceRetained`) |
| Propagación de impacto | Score que decae con la distancia (`0.75^(d-1)`) |
| Confianza de relación | Noisy-OR de fuentes; recolector + OTel + CMDB > inferida débil |

Todas las consultas van con `tenantId`. Nunca se mezcla topología entre tenants.

## Forma de `blastRadius`

```ts
{
  originKey: string;
  hops: number;
  directDependents: Array<{ entityKey, kind, name, distance }>;
  indirectDependents: Array<{ entityKey, kind, name, distance }>;
  affectedServices: Array<{ entityKey, kind, name, distance }>;
  affectedApplications: Array<{ entityKey, kind, name, distance }>;
}
```

`directDependents` = `getDependents` ∪ vecinos `findRelatedEntities` (incluye `CONNECTS_TO` de un switch).  
`indirectDependents` = expansión BFS posterior.  
`affectedServices` / `affectedApplications` son clasificaciones por `kind` (pueden solaparse con directos/indirectos).

## Supresión (configurable)

No esconde evidencia: los síntomas siguen en `members.alerts` y en `topologyEvidence`. Solo evita **varios incidentes independientes de alta prioridad** cuando la topología apunta a una causa aguas arriba (p.ej. Switch SW-03 down → un incidente, no cuatro para server / k8s / API / app).

| Variable | Default | Efecto |
|---|---|---|
| `AIOPS_ROOT_CAUSE_SUPPRESSION_ENABLED` | `true` | Activa la unión de clusters |
| `AIOPS_ROOT_CAUSE_SUPPRESSION_MIN_CONFIDENCE` | `0.55` | Confianza mínima de relación hacia la causa |
| `AIOPS_ROOT_CAUSE_SUPPRESSION_MAX_HOPS` | `4` | Distancia máxima a la causa |
| `AIOPS_TOPOLOGY_CORRELATION_HOPS` | `8` | Hops de blast radius / walks |

Si está desactivada, V2 crea los clusters originales; igual se calcula blast radius y scores.

Causa mostrada: se prefiere un nodo de infra en alerta (`switch` / `router` / …) que cubra el cluster; si no, el ancestro de `TopologyRepository`.

## Métricas

- `aiops_topology_correlations_total`
- `aiops_root_cause_suppressions_total`

Registradas en `MetricsService` como contribuidor `aiops-topology-correlation`.

## Archivos

| Path | Rol |
|---|---|
| `apps/platform-api/src/aiops/topology-correlation/` | Servicio, scoring, confianza, métricas, tests |
| `apps/platform-api/src/aiops/correlation.service.ts` | Inyección opcional + `apply` + members aditivos |
| `apps/platform-api/src/aiops/correlation-types.ts` | Kinds de evidencia y campos opcionales en `members` |
| `apps/platform-api/src/aiops/incidents.module.ts` | Providers Wave 2 |

No se tocó Prisma, AnomalyEngine, RcaEngine, UI ni AgentOrchestrator.

## Tests

Desde `ekumetrics-platform/apps/platform-api`:

```bash
npm test -- topology-correlation correlation.service.spec correlation-score.spec
```

Cubre: ancestro común, blast radius, supresión, scoring dirigido, confianza multi-fuente, falso positivo temporal sin topología, aislamiento cross-tenant, métricas y publish al EventBus.
