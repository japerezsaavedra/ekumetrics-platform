# Changelog

## Unreleased

- Añade entrega productiva de secretos mediante archivos montados, validación de permisos/longitud y rechazo de secretos inline.
- Añade borde Agent mTLS para OTLP gRPC/HTTP, elimina la publicación directa del Collector/gateway en producción y vincula `O/OU/CN` del certificado con tenant/sitio/agente.
- Protege la afirmación del certificado con una clave privada borde→API y añade una prueba real que rechaza clientes sin certificado.

Registro de cambios de Ekumetrics Platform. El formato sigue [Keep a Changelog](https://keepachangelog.com/es/1.1.0/). El versionado es [SemVer](https://semver.org/lang/es/).

## [Unreleased]

- Se incorpora un flujo automatizado y auditable de upgrade/rollback con matriz de compatibilidad, backup cifrado obligatorio, migraciones expand-contract, verificación de versión y control de digests de imágenes retenidas.

### Añadido

- Persistencia de trazas OTLP en Tempo 3.0, datasource Grafana y correlación segura métricas/logs/trazas por tenant, sitio, agente y `trace_id`.
- Evidencia visible y persistida de EkuAssistant con referencias de traza, spans, servicio, operación, duración y ventana consultada.
- Cobertura, confianza y citas `M/L/T/E/R` por respuesta de EkuAssistant, con distinción explícita entre valores normales, ausencia de datos y fuente no disponible.
- RAG híbrido por tenant para documentos, runbooks y postmortems aprobados con pgvector 0.8.6, full-text en español, RRF, reindexación atómica y citas documentales `K#`.
- Administración del corpus en el portal y conjunto dorado español con compuertas CI de recall, latencia observada y aislamiento negativo entre tenants.
- Preflight e instalador reproducible con validación de host, secretos, puertos, DNS, TLS y healthchecks.
- Backup cifrado con age, retención, manifiesto SHA-256 y restauración protegida con evidencia de RPO/RTO.
- SLIs y SLO de disponibilidad, latencia y frescura, con error budget, dashboard Grafana y alertas multi-ventana.
- Retención acotada para eventos, Prometheus, Loki y NATS, con purga por lotes y alertas de capacidad del host.
- Paquete de diagnóstico redactado, revisable y empaquetable solo tras confirmación humana explícita.
- Contrato de release con matriz portal/API/esquema/agente y bloqueo CI de migraciones destructivas no aprobadas.
- Gateway HTTP en `:4318` que separa OTLP de `POST /v1/ekms/events`.
- Ingesta validada e idempotente de eventos del agente, persistencia en PostgreSQL y actualización de inventario y `lastSeenAt`.
- Documentación de arquitectura, operación y seguridad.
- Identidades revocables para pantallas permanentes, con alcance por tenant, sitio y dashboard.
- Pruebas E2E de recorridos críticos para portal, API, ingesta y autenticación OIDC real.
- Compuerta DAST reproducible con OWASP ZAP, reportes de CI y aceptaciones de riesgo exactas y expirables.
- Sesiones web BFF stateful con referencia opaca, tokens OIDC cifrados en PostgreSQL y protección CSRF ligada al origen.
- Cifrado autenticado AES-256-GCM para credenciales de proveedores de IA, con migración automática de valores heredados y fallo cerrado.

### Cambiado

- El despliegue local se liga a `127.0.0.1`, exige secretos explícitos y usa comandos `platform:*`.
- Angular/NestJS y sus dependencias se alinean con los últimos parches estables; el runtime pasa a Node.js 24 LTS.
- PostgreSQL/pgvector, NATS, Prometheus, Loki, Alertmanager, Grafana, OpenTelemetry Collector, Keycloak, Nginx y Ollama se actualizan a ramas estables vigentes.
- JetStream usa almacenamiento persistente; Grafana queda sin acceso anónimo, telemetría ni descargas implícitas de plugins.
- OpenTelemetry y Loki adoptan la sintaxis de configuración vigente y readiness verificable en el despliegue monolítico.
- El portal renueva la sesión BFF en segundo plano sin almacenar access, refresh ni ID tokens en el navegador.
- El acceso humano migra a Authorization Code con PKCE S256 ejecutado por la API, callbacks exactos, refresh rotado y logout en Keycloak; se eliminan los endpoints que recibían contraseñas en la API.
- La validación de tokens fija RS256 para Keycloak y HS256 para kiosk, exige issuer, audiencia y tipo de token, y rechaza ID tokens como credenciales de API.
- El portal consume solo API y Grafana desde configuración runtime; el BFF es el único componente web que se comunica con Keycloak. Se endurecen CSP, COEP, caché y exposición de versión de Nginx.
- La matriz de compatibilidad con Agent 1.4 incluye ya OTLP y envelopes propios.
- El portal autoaloja tipografías e iconos y genera el bundle productivo sin depender de Google Fonts.
- El caché persistente de Angular queda deshabilitado para evitar el fallo nativo de LMDB observado en Node.js 24 sobre macOS ARM64; CI conserva el build completo como control obligatorio.

## [1.0.0] — 2026-08-21

### Añadido

- Login con Keycloak (operator, admin, viewer) y tenants, sitios y agentes inscritos.
- Dashboard de host y agente: gráficos en vivo, rango, refresco y ayuda de cadencia.
- Inventario de red, bases, colas, IceWarp y canal SAP según el YAML del agente 1.4.
- EkuAssistant AI (Holmes): prompt de producto fijo y complemento opcional por operador.
- Catálogo de modelos vigentes (Ollama, OpenAI, Claude, Grok, Kimi, DeepSeek).
- Descarga del agente 1.4 y YAML de sede alineado con la taxonomía de fábrica.

[Unreleased]: https://github.com/japerezsaavedra/ekumetrics-platform/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/japerezsaavedra/ekumetrics-platform/releases/tag/v1.0.0
