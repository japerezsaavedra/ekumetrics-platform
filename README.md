# Ekumetrics Platform

Versión **1.0.0**. Producto de observabilidad Ekumetrics: API NestJS, portal Angular y servicios de plataforma.
Compatible con **Ekumetrics Agent 1.4**: OTLP y eventos propios idempotentes en `POST /v1/ekms/events`.

El código vive en `apps/`, los contratos compartidos en `packages/` y el despliegue local en `infrastructure/docker`. Arquitectura: [docs/architecture.md](docs/architecture.md). Operación: [docs/operations.md](docs/operations.md).

Objetivos y presupuestos de error: [docs/slo.md](docs/slo.md).
Compatibilidad, actualización y rollback: [docs/releases.md](docs/releases.md).

Baseline de seguridad y evidencia ASVS: [docs/security-asvs.md](docs/security-asvs.md).

## Despliegue local

Requisitos: Docker Engine con Compose v2, Node.js 24 LTS y npm 12.

El repositorio fija npm 12.0.2 mediante Corepack. En una máquina limpia:

```bash
corepack enable
corepack install
npm --version
```

Toda la plataforma, incluida API y portal:

```bash
cp infrastructure/docker/.env.example infrastructure/docker/.env
# Reemplace todos los valores change-me-* antes de continuar.
npm run preflight
npm run platform:install
```

El instalador ejecuta el preflight, construye las imágenes, espera todos los healthchecks y comprueba API, Collector, portal y OIDC. Si falla, conserva contenedores y volúmenes para diagnóstico.

Para consultar o detener el despliegue:

```bash
npm run platform:logs
npm run platform:down
```

| Servicio | URL |
|---|---|
| Portal | http://localhost:4200 — login en `/login` |
| Gestión de alertas | http://localhost:4200/alertas — solo operador |
| API | http://localhost:3000/health |
| Keycloak | http://localhost:8080 |
| Grafana | http://localhost:3001 (`ekumetrics` / valor de `GRAFANA_ADMIN_PASSWORD`) |
| Prometheus | http://localhost:9091 |
| Tempo | http://localhost:3200 — normalmente se explora desde Grafana |
| Alertmanager | http://localhost:9093 — administrado normalmente desde el portal |
| OTLP (agente) | `localhost:4317` (gRPC) y `localhost:4318` (HTTP, `/v1/logs`) |
| PostgreSQL | `localhost:5432` |
| NATS | `localhost:4222` |
| EkuAssistant AI | http://localhost:4200/asistente (`npm run platform:ai`) |

Prometheus usa el puerto **9091** en el host para no chocar con el inventario del agente (`:9090`).

En `srv-apps` (`10.10.0.2`) se usa `infrastructure/docker/.env` con `BIND_ADDR=10.10.0.2` y `PUBLIC_HOST=10.10.0.2`. El portal queda en http://10.10.0.2:4200.

El Compose base está orientado al desarrollo local y exige secretos explícitos en `infrastructure/docker/.env`. Producción añade el override endurecido, archivos de secretos montados y un borde mTLS dedicado; consulte el runbook antes de publicar cualquier servicio.

## Agente

Para conectar una compilación de `ekumetrics-agent` al despliegue local, use:

```yaml
export:
  otlp:
    endpoint: "localhost:4317"
    insecure: true
```

El agente convierte ese endpoint en dos salidas:

- Telemetría OTLP hacia los receptores estándar de `:4317`/`:4318`.
- Eventos propios hacia `http://localhost:4318/v1/ekms/events`.

El gateway de `:4318` enruta ambas sin exigir cambios en el agente.

## Estado de la ingesta

| Señal | Estado en el despliegue local |
|---|---|
| Métricas OTLP | Recibidas por OpenTelemetry Collector y expuestas a Prometheus |
| Logs OTLP | Recibidos por OpenTelemetry Collector y enviados a Loki |
| Trazas OTLP | Normalizadas por OpenTelemetry Collector y persistidas en Tempo |
| Eventos `/v1/ekms/events` | Validados, deduplicados y persistidos en PostgreSQL; actualizan `lastSeenAt` e inventario |

Cada lote admite hasta 256 eventos y una sola identidad tenant/sitio/agente. Un agente debe estar registrado previamente. La huella SHA-256 del envelope evita duplicados cuando el buffer reintenta.

## Acceso al despliegue local

Keycloak ya arranca con `npm run platform:up`. Abra http://localhost:4200/login. Usuarios de demostración del realm `ekumetrics`:

| Usuario | Correo | Clave | Rol |
|---|---|---|---|
| operator | operator@gradotech.com | ekumetrics-local | operador (ve todos los tenants) |
| admin | admin@gradotech.com | ekumetrics-local | admin del tenant `default` |

Consola de Keycloak: http://localhost:8080 (`admin` / `ekumetrics`).

## EkuAssistant AI

El chat de `/asistente` usa el modelo elegido en `/configuracion`. Ollama corre en el mismo compose (`qwen3.5:4b`). El portal muestra el modelo en uso y si está activo, también para Grok, OpenAI o Claude.

Las conversaciones y evidencias se conservan server-side en PostgreSQL, siempre asociadas al tenant y al usuario autenticado. El navegador guarda únicamente el identificador opaco de la sesión activa; no persiste preguntas, respuestas, métricas ni logs en `localStorage`. La retención predeterminada es de 90 días y puede ajustarse por instalación.

La investigación usa herramientas internas con catálogo cerrado para métricas, logs, trazas, inventario, eventos e incidentes. El modelo nunca recibe capacidad para ejecutar PromQL, LogQL, TraceQL o SQL arbitrario; cada consulta se vuelve a autorizar contra tenant, sitio y agente y produce evidencia normalizada. Las preguntas de latencia o trazas consultan Tempo dentro de una ventana máxima de 24 horas y correlacionan los resultados con Loki por `trace_id`.

Cada respuesta muestra el resultado operativo, la ventana y entidades investigadas, una confianza calculada desde la cobertura real y el estado separado de cada fuente: con evidencia, sin datos o no disponible. Las referencias `M#`, `L#`, `T#`, `E#` y `R#` enlazan respectivamente métricas, logs, trazas, eventos e inventario con el detalle persistido de la investigación. Una fuente caída no se presenta como una medición normal ni como ausencia de eventos.

El conocimiento aprobado (documentación de producto, runbooks y postmortems) se indexa por tenant en PostgreSQL mediante full-text en español y embeddings `qwen3-embedding:0.6b` de 1.024 dimensiones. La recuperación fusiona ambos rankings con RRF y expone citas `K#` con documento, sección, versión y fecha de aprobación. La telemetría cruda nunca se vectoriza y los textos recuperados se tratan como datos no confiables, no como instrucciones.

Operator y admin gestionan el corpus desde `/configuracion`: aprobación, vigencia, reindexación por clave estable, inventario y eliminación propagada. `npm run rag:evaluate` ejecuta el conjunto dorado español contra Ollama y PostgreSQL reales usando tablas temporales; exige recall@5 de documento ≥ 0,90, recall@5 de sección ≥ 0,80 y cero resultados cruzados de tenant. CI aplica los mismos umbrales.

`npm run platform:ai` sigue siendo opcional y añade Holmes. Ollama forma parte del Compose normal.

## Tenants, sitios y agentes

Ver `docs/tenants-sitios-agentes.md`. Tipos comerciales: **Servidor**, **NOC**, **Sensor**, **Endpoint**.

## Seguridad

La política y el modelo de seguridad están en [SECURITY.md](SECURITY.md). El acceso humano usa un BFF: Angular no recibe tokens OIDC y conserva únicamente una cookie de sesión opaca `HttpOnly`; las mutaciones requieren CSRF ligado al origen.

En producción, Agent solo alcanza `agent-edge` por TLS mutuo en 4317/4318. El certificado cliente debe usar `O=<tenant_id>`, `OU=<site_id>` y `CN=<agent_id>`; la API compara esa identidad con el lote y con el inventario registrado. El Collector y el gateway HTTP sin TLS no publican puertos en el host productivo.

## Bloqueadores antes de producción

El despliegue local verifica el contrato funcional, pero no constituye por sí solo una topología productiva. Quedan decisiones explícitas:

- Integrar el gestor de secretos y la PKI corporativos con las interfaces de archivos montados ya implementadas; no se aceptan valores secretos dentro del `.env` productivo.
- Ejecutar una prueba mTLS y de rotación con certificados reales de cada entorno, además de la prueba automatizada incluida.
- Validar la retención contractual y conectar archivo/object storage externo para telemetría que deba conservarse más de 30 días.
- Migrar Tempo y Loki a almacenamiento de objetos administrado antes de una topología distribuida o de alta disponibilidad; el volumen local incluido cubre instalaciones de un solo nodo.
- Migrar el portal fuera de `@angular/animations` antes de Angular 23.
- Diseñar alta disponibilidad, restauración probada, rate limiting y capacidad según SLA/RPO/RTO.

Estos puntos son bloqueadores documentados del despliegue productivo.
