# Wave 1 — Topology Domain V2

Abstracción `TopologyRepository` sobre el grafo PostgreSQL existente (`GraphNode` / `GraphEdge` / `GraphService`). **No** hay Neo4j, Redis ni segundo grafo.

## Decisión

| Opción | Resultado |
|---|---|
| Tablas `Entity` / `Relationship` nuevas | **No.** `GraphNode` ≈ Entity, `GraphEdge` ≈ Relationship. |
| Enum Prisma rígido para `relation` | **No.** Sigue `String`; el catálogo vive en constantes TypeScript. |
| Columna `firstSeen` | **No.** Se reutiliza `GraphEdge.createdAt`. |
| Columna `lastSeen` | **No.** Se reutiliza `GraphEdge.lastSeenAt`. |
| Columna `source` | **Ya existía.** |
| Columna `confidence` | **Sí, opcional.** No había equivalente. |
| UI Cytoscape | **Sin rediseño.** `GET /v1/graph` conserva `from` / `to` / `relation`. |

Ingesta LLDP/CDP (`GraphService.upsertNeighbor`) sigue escribiendo `CONNECTS_TO`. `graph-walk.ts` no se modificó: la correlación sigue recorriendo aristas como grafo no dirigido.

## API `TopologyRepository`

Token Nest: `TOPOLOGY_REPOSITORY` (`Symbol`). Implementación: `PostgresTopologyRepository` (envuelve `GraphService`).

Todas las consultas reciben `tenantId` y lo aplican en Prisma. `siteId` es filtro opcional.

| Método | Semántica |
|---|---|
| `getEntity` | Nodo por `entityKey` (`GraphNode.nodeKey`). |
| `getDependencies` | Salientes `DEPENDS_ON`, `USES`, `RUNS_ON`, `STORES_IN`, `BACKED_BY`, `ROUTES_THROUGH`, `MEMBER_OF`; más entrantes `HOSTS` / `EXPOSES`. |
| `getDependents` | Inverso de lo anterior. |
| `getAncestors` | BFS dirigido por dependencias (hops default 8). |
| `getDescendants` | BFS dirigido por dependientes. |
| `getPath` | Camino más corto **no dirigido** (incluye `CONNECTS_TO`). |
| `getCommonAncestor` | Intersección de ancestros dirigidos; si no hay jerarquía, `commonCover` sobre el grafo (LLDP). |
| `findRelatedEntities` | Vecinos no dirigidos (hops default 1). |

Opciones: `{ siteId?, relations?, hops? }`.

Tipos de relación (único sitio de literales): `RUNS_ON`, `DEPENDS_ON`, `CONNECTS_TO`, `HOSTS`, `USES`, `MEMBER_OF`, `ROUTES_THROUGH`, `STORES_IN`, `EXPOSES`, `BACKED_BY`, `COMMUNICATES_WITH`.

`CONNECTS_TO` y `COMMUNICATES_WITH` se tratan como no dirigidos. `HOSTS` es el inverso de `RUNS_ON` (vale modelar pod→nodo o nodo→pod).

En relaciones, `firstSeenAt` = `createdAt`, `lastSeenAt` = `lastSeenAt`, `source` = `source`, `confidence` = columna nueva nullable.

## Schema / migración

Migración: `20260904230000_topology_v2` (backwards compatible).

```sql
ALTER TABLE "GraphEdge" ADD COLUMN "confidence" DOUBLE PRECISION;
CREATE INDEX "GraphNode_tenantId_kind_idx" ON "GraphNode"("tenantId", "kind");
CREATE INDEX "GraphEdge_tenantId_relation_idx" ON "GraphEdge"("tenantId", "relation");
```

Índices previos se conservan: unique `(tenantId, nodeKey)`, `(tenantId, fromKey, toKey, relation, source)`, y lookups tenant-scoped por `siteId` / `fromKey` / `toKey`.

Filas LLDP existentes no cambian: `relation='CONNECTS_TO'`, `confidence` NULL.

## GraphService (extendido, no reemplazado)

- `upsertNeighbor` → `upsertRelation(..., CONNECTS_TO)` (LLDP/CDP / grafo de ejemplo).
- `upsertRelation` acepta el catálogo tipado y `confidence` opcional (0–1).
- `listNodes` / `listEdges` alimentan el repositorio.
- `links()` / `impact()` / `snapshot()` / `seedExample()` sin cambio de contrato para correlación y UI.
- `snapshot().edges` añade campos opcionales `confidence`, `firstSeenAt`, `lastSeenAt`. Cytoscape sigue usando `from`/`to`.

## Archivos

| Path | Rol |
|---|---|
| `src/aiops/topology.relations.ts` | Constantes de relación |
| `src/aiops/topology.repository.ts` | Interfaz + DTOs |
| `src/aiops/topology-walk.ts` | Recorridos dirigidos / no dirigidos |
| `src/aiops/topology.postgres.repository.ts` | Impl. Postgres |
| `src/aiops/graph.service.ts` | Persistencia (extendido) |
| `src/aiops/incidents.module.ts` | `TOPOLOGY_REPOSITORY` |
| `prisma/schema.prisma` | `GraphEdge.confidence` + índices |
| `prisma/migrations/20260904230000_topology_v2/` | SQL |

No se tocó: `CorrelationService`, ingest, `AgentEvent`, messaging, portal, modelos RCA.

## Tests

```
npm test -- topology-walk.spec graph-walk.spec topology.postgres.repository.spec
```

(desde `apps/platform-api`)

- Recorridos dirigidos vs `CONNECTS_TO` no dirigido.
- Aislamiento de tenant.
- LLDP `CONNECTS_TO` + `graph-walk` (`walk` / `sharePath` / `commonCover`).
- Snapshot `from`/`to`/`relation` para UI.
- `graph-walk.spec.ts` intacto.

## Compatibilidad UI

`/investigacion` y `/v1/graph` no cambian de ruta ni de forma mínima de arista (`from`, `to`, `relation`, `source`, `siteId`). No hay rediseño Cytoscape en esta tarea.

## Limitaciones

- Caminos y “related” cargan aristas del tenant (o sitio) en memoria, igual que `GraphService.impact`.
- No hay sync CMDB externo ni TTL/stale automático (`lastSeenAt` queda listo para ello).
- `TopologyRepository` no publica `ekumetrics.topology.updated` (EventBus es otro workstream).
- No hay endpoints HTTP nuevos; el portal sigue hablando con `GraphService` vía correlación.
