# Plan de evolución — Ekumetrics Agent (recolector)

> **Ámbito:** `ekumetrics-agent/` — software recolector en infra del cliente.  
> **No confundir** con AIOps Agents (`RcaAgent`, `MetricsAgent`, orquestador) dentro de Platform.  
> **Naturaleza de este documento:** plan de evolución. No es especificación de implementación ni código.

---

## 1. Estado actual (auditoría)

### 1.1 Forma del producto

Un solo binario (`cmd/agent`, variante Windows `cmd/agentw1`) + un YAML (`config/agent.yaml`). El operador activa interruptores; por debajo corren:

| Capa | Qué hace hoy | Paths clave |
|------|--------------|-------------|
| Orquestación local | Arranque, licencia, métricas de identidad, ciclo de vida de módulos | `cmd/agent/main.go`, `pkg/agent/core/` |
| Config / modos | `site` \| `central` \| `sensor` \| `endpoint`; alias `servers`/`snmp`/`databases`… | `pkg/agent/config/`, `docs/ROL.md`, `docs/COMPONENTES.md` |
| Collector OTel embebido | Genera YAML otelcol y lo lanza: hostmetrics, process, scrape, SNMP, OTLP receive, datastore/queue | `pkg/modules/collector/` |
| Logs | Fluent Bit embebido (ficheros, journald, Windows Event, reenvío OTLP) | `pkg/modules/fluentbit/` |
| Discovery pasivo | Semillas SNMP → ARP/LLDP/CDP/ENTITY; talkers NetFlow; inventario local | `pkg/modules/discovery/` |
| NetFlow | Listener v5 → metadatos + envelope `flow.*` | `pkg/modules/netflow/` |
| Traps SNMP | UDP opcional → envelope `snmp.trap` | `pkg/modules/collector/trap*.go` |
| Probes | ICMP/TCP RTT | `pkg/modules/probes/` |
| SAP (red) | SPAN/TAP, sesiones, parsers opcionales, Zeek opcional | `pkg/modules/sap/`, `pkg/sap/`, `pkg/ingest/` |
| Envelope + buffer | Eventos JSON hacia Platform `/v1/ekms/events` | `pkg/ekms/envelope/`, `pkg/ekms/buffer/` |
| TLS/mTLS export | TLS 1.2+, cliente opcional | `pkg/ekms/mtls/` |

**No hay Kubernetes discovery** en el Agent. La topología K8s de Platform viene de `kube-state-metrics` / telemetría de clúster, no del recolector de sede.

### 1.2 Modos de instalación

| YAML `agent.mode` | Rol | Madurez |
|-------------------|-----|---------|
| `site` | Servidor de sede: host + SNMP + NetFlow + traps + probes + inventario | Operativo (fase B+C) |
| `central` | NOC / APIs de gestores | **Reservado** (sin conectores) |
| `sensor` | SPAN/TAP; canal SAP | Operativo en Linux |
| `endpoint` | PC/portátil (métricas/logs locales) | Parcial (mismo motor host/logs; sin MDM) |

### 1.3 Envelope y camino a Platform

```text
Discovery / NetFlow / Traps
        │  envelope.Event
        ▼
export.buffer (JSONL persistente) ──batch──► POST …/v1/ekms/events
        │                                       (Platform API → PG + GraphNode/Edge)
OTLP (métricas/logs/trazas)
        │
        ▼
otelcol exporter ──► Agent Edge :4317/:4318 ──► Collector ──► Prom/Loki/Tempo
```

Señales envelope hoy (`pkg/ekms/envelope/envelope.go` + contrato Platform):

- `asset_discovered` | `asset_updated` | `asset_stale` | `mac_changed`
- `neighbor_observed` → alimenta `GraphService.upsertNeighbor` (CMDB/Topology)
- `flow.bytes` | `flow.new`
- `snmp.trap`

Heartbeat lógico: cualquier lote válido actualiza `Agent.lastSeenAt` en Platform; series `ekms_agent_info` / `ekms_agent_identity` en `:9090`.

### 1.4 Discovery → topología (hoy)

| Capacidad | Estado |
|-----------|--------|
| Inventario sugerido local (`/inventory`, cache) | Existe |
| LLDP/CDP/ARP/ENTITY via SNMP v2c | Existe |
| Emisión `neighbor_observed` con tags hacia grafo | Existe (Agent → ingest → `GraphNode`/`GraphEdge`) |
| Walk SNMP v3 en discovery | Semilla declarable; walk **no** |
| Discovery activo (ICMP/TCP) | Apagado; aunque `authorized`, **no barre** |
| Escritura CMDB canónica / reconciliación | No (solo sugerido + eventos) |
| Dependencias L7 / service map genérico | No (salvo vecinos L2/L3 y flujos) |

---

## 2. Principio de evolución

**Extender el Agent por módulos internos**, no reemplazarlo por una flota de collectors independientes como arquitectura primaria.

- Un proceso, un YAML, un export OTLP + un canal envelope.
- Cada “Collector” propuesto es un **módulo** (paquete + interruptor + contrato de señales), no un proceso nuevo por dominio.
- Reutilizar `collector` (otelcol), `fluentbit`, `discovery`, `buffer` como infra compartida.
- Compatibilidad YAML: seguir leyendo `modules.*` 1.2.x y bloques `servers`/`snmp`/… 1.4.x.

Fuera de alcance de este plan: reescritura del Agent, collectors sidecar por defecto, o sustituir el orquestador AIOps por HolmesGPT.

---

## 3. Mapa de módulos propuestos → código actual

| Módulo propuesto | Estado | Path actual o «nuevo» | Notas |
|------------------|--------|------------------------|-------|
| **HostCollector** | Existe (parcial) | `pkg/modules/collector/configgen.go` (`hostmetrics`), `modules.metrics.host` / `servers.this` | CPU, mem, disco, load, NICs. Intervalo `agent.interval`. |
| **ProcessCollector** | Existe (parcial) | mismo `hostmetrics` scraper `process`; `modules.metrics.processes` | Sin filtro de names = cardinalidad alta. |
| **ServiceCollector** | Parcial / hueco | `apps.go` (datastore/queue receivers), `probes`, IceWarp; **nuevo** para systemd/Windows services genéricos | Hoy: BBDD/colas/IceWarp como “servicios de aplicación”, no catálogo OS services. |
| **LogCollector** | Existe | `pkg/modules/fluentbit/`, `modules.logs` | Ficheros, journald, Windows Event, OTLP logs. |
| **NetworkCollector** | Parcial | hostmetrics `network` + `probes` + alias YAML `network`/`firewalls` (SNMP) | Unificar semántica “red de sede” vs métricas NIC del host. |
| **SnmpCollector** | Existe | `pkg/modules/collector/snmp*.go`, `snmp.devices`, traps `trap*.go` | if-mib, host-mib, ups, IceWarp; traps fríos. |
| **NetflowCollector** | Existe (v5) | `pkg/modules/netflow/` | v9/IPFIX solo contados. |
| **OTelAdapter** | Existe | `receive.otlp` + exporters en `configgen.go`; export envelope vía buffer | Recepción apps + reexport OTLP; no es un “adapter” nombrado. |
| **KubernetesDiscovery** | **Nuevo** | — | No en Agent; Platform ya usa kube-state-metrics. Evaluar si vive en Agent (modo cluster) o solo Platform. |
| **SAPNetworkCollector** | Existe | `pkg/modules/sap/`, `pkg/sap/`, `pkg/ingest/` | Metadatos de sesión; decode/work solo con autorización. |
| **DependencyDiscovery** | Parcial → extender | `discovery/` (LLDP/CDP/ARP + `neighbor_observed`), NetFlow `flow.new`, SAP talkers | Falta mapa de dependencias servicio↔servicio y export sistemático a grafo. |

Infra transversal (no son “collectors de dominio” pero son módulos de plataforma del Agent):

| Pieza | Path |
|-------|------|
| Envelope | `pkg/ekms/envelope/` |
| Buffer / retry / batch / compress | `pkg/ekms/buffer/` |
| mTLS cliente | `pkg/ekms/mtls/` |
| Identidad / heartbeat métrico | `pkg/agent/core/` |
| Licencia (gate de recolección) | `pkg/license/` |

---

## 4. Capacidades transversales: existe vs falta

| Capacidad | YA existe | Falta / madurar |
|-----------|-----------|-----------------|
| **Buffering local** | Cola JSONL persistente (`export.buffer`, max items/bytes) | Compactación avanzada, partición por señal, métricas de profundidad en export |
| **Retry** | Backoff exponencial hasta 60s en `Flusher` | Jitter, circuit breaker, DLQ explícita, honrar `Retry-After` |
| **Batching** | Lotes envelope (default 32); Platform 1–256 | Alinear `Batch` configurable en YAML; batch OTLP ya en otelcol |
| **Compression** | gzip opcional en export envelope (`compress`) | Compresión por defecto en prod; métricas de ratio |
| **Heartbeat** | `ekms_agent_*` + `lastSeenAt` por lote | Envelope dedicado `agent.heartbeat` (opcional) para sitios sin eventos de asset |
| **TLS** | TLS 1.2+, mTLS con cert/key, CA | Rotación en caliente, OCSP/CRL, pinning de SPKI |
| **Credential rotation** | `passwordFile` en datastore/IceWarp; community/v3 en YAML | Vault/CSI, reload sin restart, rotación de certs Agent Edge (Platform ya tiene `credentialVersion`) |
| **Versioned protocol** | Contrato implícito Agent 1.4 ↔ OpenAPI Platform | Campo `protocol_version` / negociación; matriz formal en Agent |
| **Backward compatibility** | YAML 1.2 `modules.*` + 1.4 componentes; señales cerradas en ingest | Política de deprecación documentada; tests de fixtures multi-versión |
| **Discovery CMDB/Topology** | Inventario local + `neighbor_observed` → GraphNode | Reconciliación CMDB, confidence, stale de edges, v3 walk, IPFIX |

---

## 5. Diseño por módulo (evolución, no código)

### 5.1 HostCollector / ProcessCollector

- **Hoy:** otelcol `hostmetrics` generado.
- **Evolución:** perfiles por modo (`site` vs `endpoint`); límites de cardinalidad en procesos; etiquetas `tenant.id` / `host.site` / `agent.id` ya vía transform Platform — asegurar simetría en Agent.
- **Salida:** OTLP metrics (bus de telemetría). Envelope solo si se modelan umbrales locales (fase posterior).

### 5.2 ServiceCollector

- **Hoy:** probes + receivers BBDD/colas/IceWarp.
- **Evolución:** módulo que declare “unidad de servicio” (nombre, endpoint, health) y emita nodos/edges lógicos (`depends_on`) hacia envelope, sin scraper genérico de todos los systemd units por defecto.
- **Prioridad:** media; alimenta Topology Agent AIOps.

### 5.3 LogCollector

- **Hoy:** Fluent Bit + OTLP logs.
- **Evolución:** plantillas por componente (IceWarp, SAP work file, syslog ingest); no parseo de payload sensible; correlación `trace_id` ya en Collector de Platform.

### 5.4 NetworkCollector

- **Hoy:** fragmentado (NIC host + SNMP role + probes).
- **Evolución:** fachada de configuración `network.*` que encienda SNMP/probes/NetFlow sin duplicar targets; señales de interfaz (`ifOperStatus`) ya vía SNMP metrics → enriquecer eventos de topología en cambios.

### 5.5 SnmpCollector

- **Hoy:** operacional.
- **Evolución:** discovery walk v3; MIBs vendor acotadas; parsing traps por OID conocido; misma semilla para métricas y discovery (evitar doble lista).

### 5.6 NetflowCollector

- **Hoy:** v5 → `flow.*` + inventario talkers.
- **Evolución:** IPFIX/sFlow selectivo; sampling consciente; edges de grafo solo para `flow.new` con umbral (evitar explosión de GraphEdge).

### 5.7 OTelAdapter

- **Hoy:** receive + export.
- **Evolución:** renombrar conceptualmente (docs/YAML) como adaptador; health de pipelines; no abrir gRPC sin módulos OTLP activos (ya parcialmente).

### 5.8 KubernetesDiscovery

- **Nuevo en Agent solo si** hay modo `cluster` / DaemonSet del recolector.
- **Alternativa preferida a corto plazo:** Platform sigue siendo fuente K8s; Agent no duplica.
- Si se añade: discovery de pods/services/endpoints → envelope `k8s.*` versionado, no scraping arbitrario de API.

### 5.9 SAPNetworkCollector

- **Hoy:** canal maduro en sensor.
- **Evolución:** volcar sesiones/talkers a envelope (`sap.session_*` o reutilizar `flow`/`neighbor`) para Topology/Network AIOps; mantener payload gated.

### 5.10 DependencyDiscovery

- **Hoy:** L2/L3 vecinos + flujos + SAP implícito.
- **Evolución:** capa que unifique fuentes → grafo canónico de facts (`neighbor_observed`, futuros `depends_on`); IDs estables `site/<site>/ip/<ip>`; confidence y stale de edges alineados con Platform `GraphService`.

---

## 6. Huecos de ingestión hacia un “bus”

Hoy hay **dos buses de facto**, no uno:

| Bus | Transporte | Consumidores | Hueco |
|-----|------------|--------------|-------|
| Telemetría | OTLP gRPC/HTTP | Prom / Loki / Tempo | Sin bus de mensajes propio; OK para AIOps Metrics/Logs |
| Eventos / topología | HTTP envelope batch | PostgreSQL, GraphNode | No hay Kafka/NATS en el camino Agent→Platform; buffer local mitiga |

Huecos relevantes para AIOps:

1. **SAP y probes** no drenan al envelope (solo métricas/logs locales o stdout).
2. **Sin señal heartbeat envelope** cuando no hay assets/flujos (sedes “silenciosas”).
3. **protocol_version** ausente → evolución de señales frágil.
4. **Credential/cert rotation** sin reload → downtime operativo.
5. **modo `central`** vacío → no hay ingestión NOC.
6. **K8s** no pasa por el Agent de sede (aceptable si se documenta el dual-path).
7. **Batch size** del Agent no expuesto en YAML (default 32 vs techo Platform 256).

Cambios mínimos deseables (solo plan):

1. Asegurar `discovery.passive` + SNMP semillas + export envelope en sedes objetivo.
2. Exponer `export.buffer.batch` y `compress: true` en plantillas Platform.
3. Drenar SAP talkers / session closed → 1–2 señales envelope acotadas.
4. Añadir `protocol_version: "1.4"` al lote (campo nuevo + aceptación Platform).
5. Heartbeat envelope periódico opcional si `Len()==0` y export configurado.
6. Documentar que GraphNode se alimenta de `neighbor_observed` (y assets), no de OTLP.

---

## 7. Fases sugeridas (orden, no fechas)

| Fase | Objetivo | Módulos tocados |
|------|----------|-----------------|
| **E0** | Contrato y observabilidad del canal | Envelope versionado, batch YAML, heartbeat, métricas de buffer |
| **E1** | Topología fiable en sede | SnmpCollector v3 discovery, DependencyDiscovery (stale edges), NetFlow umbral a grafo |
| **E2** | Señales de negocio al bus de eventos | SAPNetworkCollector → envelope; ServiceCollector facts |
| **E3** | Credenciales y edge | Rotation/reload TLS y passwordFile; alinear con `credentialVersion` Platform |
| **E4** | Extensiones opcionales | IPFIX, modo central connectors, KubernetesDiscovery *solo si* hay despliegue cluster del Agent |

Cada fase **extiende** paquetes existentes; no introduce collectors independientes como default.

---

## 8. Relación con AIOps (solo contexto)

```text
Ekumetrics Agent (este plan)
  → OTLP + envelope
    → Correlación / IncidentContext
      → AgentOrchestrator → Metrics/Logs/Topology/… (AIOps Agents)
```

El Topology Agent AIOps **consume** GraphNode/edges ya persistidos; la calidad del grafo depende de DependencyDiscovery + LLDP/NetFlow/SAP del recolector, no del LLM.

---

## 9. Resumen para el orquestador (≤10 líneas)

1. El Ekumetrics Agent 1.4 es un recolector monolítico modular (otelcol + fluent-bit + discovery + netflow + SAP + buffer), no un AIOps Agent.  
2. Ya tiene buffering, retry, batch, compress opcional, TLS/mTLS y envelope hacia `/v1/ekms/events`.  
3. Discovery pasivo (LLDP/CDP/ARP) ya emite `neighbor_observed` → GraphNode/Edge en Platform.  
4. Faltan: protocol versioned, rotación de credenciales/certs, walk SNMP v3, IPFIX, modo central, K8s en Agent, heartbeat envelope.  
5. Hay dos caminos de ingestión (OTLP vs envelope); no hay bus de mensajería intermedio.  
6. Hueco crítico para topología/eventos: SAP/probes casi no alimentan envelope; solo discovery/netflow/traps.  
7. Evolución = módulos internos (Host/Process/Log/SNMP/Netflow/SAP/OTel/Dependency), no collectors independientes.  
8. KubernetesDiscovery: nuevo solo si hay Agent en cluster; hoy la fuente K8s es Platform.  
9. Cambio mínimo para topología: passive on + semillas SNMP + export envelope (+ umbral `flow.new`).  
10. Cambio mínimo para eventos AIOps: versionar protocolo, drenar SAP talkers a envelope, heartbeat si no hay assets.
