# Arquitectura de Ekumetrics Platform

## Objetivo y alcance

Ekumetrics Platform es el plano de control y consulta de Ekumetrics. Recibe telemetría y eventos de Ekumetrics Agent, administra tenants/sitios/agentes y presenta datos operativos en el portal.

El directorio `infrastructure/docker` contiene el despliegue local reproducible y un override productivo endurecido. El override incorpora borde mTLS y consumo de secretos montados, pero el entorno de instalación todavía debe aportar PKI, gestor de secretos, proxy HTTPS para interfaces humanas, copias de seguridad, alta disponibilidad y retención dimensionada.

## Componentes

| Componente | Responsabilidad | Datos persistentes |
|---|---|---|
| Portal Angular | Interfaz y visualización | Cookie opaca `HttpOnly` para sesión humana; credencial opaca por dispositivo en `localStorage` para pantallas permanentes |
| API NestJS / BFF | PKCE, sesión web, control, autorización, ingesta y consultas | Sesiones y datos de producto en PostgreSQL; tokens OIDC cifrados |
| Agent edge | Terminación mTLS, autenticación del certificado y entrada OTLP externa | Ninguno |
| Gateway de ingesta | Enrutamiento HTTP para desarrollo local | Ninguno |
| OpenTelemetry Collector | Recepción y transformación OTLP | Ninguno |
| Prometheus | Métricas | Volumen `prometheus-data` |
| kube-state-metrics | Objetos del clúster Kubernetes para E-Platform | Ninguno |
| Loki | Logs | Volumen `loki-data` |
| Tempo | Trazas y búsqueda TraceQL | Volumen `tempo-data` |
| Grafana | Exploración y dashboards | Volumen `grafana-data` |
| Keycloak | Identidad de usuarios | En el despliegue local usa almacenamiento propio no persistente |
| Ollama/Holmes | Modelo local e investigación opcional | Volumen `ollama-data` |

## Flujo de datos del agente

```text
Ekumetrics Agent
  └─ mTLS :4317/:4318 ─> Agent Edge
                           ├─ OTLP gRPC/HTTP ─────> OpenTelemetry Collector
                           │                         ├─ métricas ─> Prometheus
                           │                         ├─ logs ─────> Loki
                           │                         └─ trazas ───> Tempo
                           └─ /v1/ekms/events ────> Platform API ─> PostgreSQL
```

El agente deriva `/v1/ekms/events` y el puerto HTTP 4318 desde `export.otlp.endpoint`. Por eso el borde comparte 4318 con OTLP HTTP. En desarrollo local, `ingest-gateway` conserva el mismo contrato sin mTLS; en producción, sus puertos y los del Collector se eliminan del host y solo se publican los listeners TLS de `agent-edge`.

## Contrato de eventos

La fuente normativa es `packages/shared-contracts/openapi/platform-v0.yaml`. La implementación está en `apps/platform-api/src/ingest`.

Reglas:

- De 1 a 256 envelopes por solicitud; límite HTTP de 1 MiB en la API y 4 MiB en el gateway.
- Una identidad `tenant_id`, `site_id`, `agent_id` por lote.
- Tenant, sitio y agente deben existir y coincidir.
- Solo se aceptan señales definidas por Agent 1.4.
- La API calcula una huella SHA-256 canónica. La restricción única evita duplicados tras reintentos.
- `asset_*` y `mac_changed` actualizan inventario; todo lote válido actualiza `Agent.lastSeenAt`.
- La transacción incluye eventos, inventario y heartbeat lógico. Un fallo revierte el lote completo.

## Límites de confianza

1. Navegador → API: cookie BFF opaca, protección CSRF y autorización por tenant/rol. Los tokens Keycloak no llegan al navegador.
2. Agente → borde: en desarrollo se restringe a la red local; en producción exige TLS 1.2/1.3 y un certificado emitido por la CA configurada.
3. Borde → API: `INGEST_SHARED_KEY` más `AGENT_EDGE_ASSERTION_KEY`, nunca enviadas por el agente ni expuestas al navegador. El borde remite el DN verificado y la API exige `O=tenant`, `OU=site` y `CN=agent` coincidentes con el lote.
4. API → PostgreSQL/Prometheus/Loki/Tempo/Keycloak: red privada de servicios y credenciales gestionadas.

La identidad declarada en el JSON evita cruces accidentales, pero no sustituye la autenticación del canal. En producción, una petición de eventos falla cerrada si falta la afirmación privada del borde, el DN no es válido, la identidad no coincide o el agente no está registrado. OTLP también exige certificado cliente en el borde; la vinculación semántica tenant/sitio/agente se aplica al contrato propio de eventos antes de persistirlo.

## Retrieval API interna de EkuAssistant

EkuAssistant no entrega al modelo acceso directo a Prometheus, Loki, Tempo ni PostgreSQL. `RetrievalService` expone únicamente ocho operaciones de solo lectura con parámetros tipados: salud del host, series permitidas, anomalías estadísticas, búsqueda de logs, búsqueda/correlación de trazas, dependencias de componentes, eventos del agente e incidentes abiertos.

Cada operación aplica estas invariantes antes de consultar una fuente:

- valida el tenant en PostgreSQL y, cuando corresponde, la clave compuesta `tenantId + agentId`;
- obtiene el sitio autorizado desde el inventario, no desde el texto del modelo;
- construye PromQL, LogQL y TraceQL desde un catálogo cerrado; ninguna operación acepta consultas libres;
- limita las ventanas a 24 horas, las series a 20, los puntos a 600 y las filas entre 50 y 200 según la fuente;
- elimina etiquetas no aprobadas y redacta tokens, claves y contraseñas de las líneas de log;
- genera evidencia con fuente, operación normalizada, ventana, cantidad y timestamp.

La respuesta y el historial incorporan un contrato de investigación versionable: ventana, agentes y sitios efectivos, cobertura por fuente, resultado y confianza. Las citas usan prefijos estables (`M` Prometheus, `L` Loki, `T` Tempo, `E` PostgreSQL y `R` inventario) con numeración local a cada turno. La confianza no la inventa el modelo: la API la deriva de cuántas fuentes solicitadas entregaron evidencia, respondieron sin datos o no estuvieron disponibles. Las consultas de retrieval se resuelven de forma independiente; una falla parcial queda registrada como `unavailable` y permite responder con confianza reducida sin convertirla en un falso estado saludable.

### Conocimiento híbrido

`KnowledgeService` admite exclusivamente documentos aprobados de tipo `product`, `runbook` o `postmortem`; no admite logs, métricas ni trazas como corpus vectorial. La clave de fuente es única dentro del tenant: reindexar reemplaza atómicamente el documento y sus fragmentos, mientras que eliminarlo propaga el borrado mediante la FK. Cada fragmento conserva heading, hash, modelo de embedding y vector de 1.024 dimensiones.

La consulta filtra tenant, vigencia y borrado antes de rankear. PostgreSQL combina `tsvector` en español con similitud coseno HNSW de pgvector y fusiona los primeros 50 candidatos de cada canal mediante Reciprocal Rank Fusion. Si el servicio de embeddings falla durante una consulta, conserva la búsqueda lexical; durante indexación falla cerrada para impedir un corpus parcialmente vectorizado. Las citas `K#` muestran documento, sección, versión y aprobación.

El conjunto dorado versionado contiene preguntas operativas reales en español y distractores con coincidencia exacta pertenecientes a otro tenant. La evaluación crea tablas temporales, genera embeddings reales, ejecuta la misma fusión RRF y revierte la transacción. La compuerta de CI exige recall@5 de documento ≥ 0,90, recall@5 de sección ≥ 0,80 y cero cruces de tenant.

El inventario cubre hosts, red y dispositivos SNMP, bases de datos, colas, SAP, IceWarp y activos. Las series tipadas añaden procesos, CPU, memoria, carga y tráfico. Eventos e incidentes se consultan con filtros Prisma construidos por la aplicación y siempre incluyen `tenantId`; no existe una interfaz de SQL arbitrario.

### Trazas y correlación

El Collector normaliza en cada recurso OTLP `tenant.id`, `host.site`, `agent.id`, `service.namespace`, `service.name` y `service.instance.id`; Tempo conserva `trace_id` y `span_id` como campos intrínsecos. En logs correlacionados, el Collector copia ambos identificadores a atributos cuando existen, sin promoverlos a etiquetas indexadas de Loki para evitar cardinalidad no acotada.

La búsqueda de EkuAssistant siempre incluye tenant, sitio, agente y `service.namespace=ekumetrics`, con `start`/`end` obligatorios. El servidor limita cada petición a 24 horas, 20 trazas y tres spans por spanset. Las preguntas de latencia añaden `trace:duration > 500ms`; las de error añaden `span:status = error`. Los `trace_id` devueltos se cruzan únicamente con el stream Loki ya autorizado y las trazas, spans y líneas resultantes se guardan como evidencia de la investigación, no solo dentro del texto generado.

Grafana provisiona Tempo con enlaces de traza a logs filtrados por `trace_id`, `span_id` y las mismas dimensiones de recurso. El backend monolítico es deliberado para la instalación single-node; una instalación distribuida debe usar object storage y el modo de despliegue soportado por Tempo.

## Fallos y reintentos

- La API responde `202` solo después de confirmar la transacción.
- `400` indica un contrato inválido; `401` un canal mal configurado; `403` una identidad no registrada.
- `5xx` mantiene los eventos en el buffer del agente y provoca reintento con backoff.
- Un reintento de un lote confirmado es seguro: se contabiliza como duplicado y no crea otra fila.
