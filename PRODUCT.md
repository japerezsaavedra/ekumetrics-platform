# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Usuario primario: SRE, NOC u operador en turno. Diagnostica incidentes y observa la plataforma bajo presión de tiempo; necesita escanear, correlacionar y actuar sin narrativa de marketing.

Audiencias secundarias presentes en el producto (roles Keycloak): `operator` (ve todos los tenants), `admin` de tenant (sitios, usuarios, umbrales, identidad, modelos de IA, descarga del recolector) y `viewer`. Pantallas kiosk para tableros permanentes en sala NOC.

## Product Purpose

Ekumetrics es una plataforma de observabilidad y operación: inventario y topología de infra, telemetría (métricas, logs, trazas, eventos), alertas/incidentes e investigación AIOps en un solo producto.

El portal (`ekumetrics-platform/apps/portal-web`) es el plano de control y consulta. Recibe señales de **Ekumetrics Agent** (recolector en infra del cliente) y presenta salud, inventario, grafos de investigación y EkuAssistant.

Éxito: un operador en turno localiza causa y contexto (host, sitio, tenant, vecinos de red, evidencia) más rápido que saltando entre Grafana, inventario y tickets, sin que el modelo invente consultas ni cruce tenants.

## Positioning

No es un monitor genérico ni un wrapper de Grafana. El mecanismo propio es la cadena **Ekumetrics Agent → eventos EKMS + OTLP → inventario/topología → correlación de incidentes → investigación en portal**, con EkuAssistant limitado a un catálogo cerrado de retrieval (sin PromQL/LogQL/TraceQL/SQL arbitrario hacia el modelo).

**HolmesGPT / Holmes no es la arquitectura AIOps**; es un motor/backend opcional de EkuAssistant y, en Wave 3, tool layer de solo lectura del `KubernetesAgent` (opt-in, fail-open). Los investigadores lógicos son **AIOps Agents** (`Rca`, `Metrics`, `Logs`, `Kubernetes`, `Topology`, `Synthesis`). El orquestador es `AgentOrchestratorService` en `platform-api`. La investigación automática es opt-in por tenant (`AiopsInvestigationPolicy.mode`, default `MANUAL`). `privacyMode` vive en esa política, no en `AiSettings` global.

## Operating Context

- UI de producto en **español** (`lang="es"`). Rutas y navegación: Hosts, Red, Agentes, Bases de datos, Colas, IceWarp, SAP, Dashboards, Investigación, Alertas/Incidentes, E-Platform, Administración, EkuAssistant AI.
- Sesión humana vía BFF (cookie opaca HttpOnly); el navegador no recibe tokens OIDC. Mutaciones con CSRF.
- Multi-tenant: tenant / sitio / recolector registrados. Tipos comerciales de recolector: Servidor, NOC, Sensor, Endpoint.
- Tema claro/oscuro en el portal. Kiosk para dashboards en pantalla permanente.
- Dev local: portal `http://localhost:4200` (`ng serve` en `portal-web`); login `/login`. Grafana y Prometheus existen como compañeros de plataforma, no como la UI de producto.
- Uso típico: turno NOC, incidentes abiertos, grafo de investigación (Cytoscape), chat de EkuAssistant con citas `M#` `L#` `T#` `E#` `R#` `K#`.

## Capabilities and Constraints

Capacidades confirmadas en el portal: dashboards, hosts y módulos opcionales de tenant (red, bases de datos, colas, IceWarp, SAP), alertas y canales, incidentes, investigación/topología, salud E-Platform, administración (tenants, usuarios, sitios, identidad, umbrales, modelos de IA), descarga de **Ekumetrics Agent**, EkuAssistant, kiosk.

Restricciones durables:

- Nomenclatura de producto (vinculante): **Ekumetrics Agent** = recolector en infra del cliente. **AIOps Agent** / «agente de investigación» = investigador lógico dentro de la plataforma. No reutilizar el string `agent` para ambos en UI, docs, logs ni tipos.
- Stack del portal ya existe: Angular standalone, reactive forms (`FormGroup` / `formControlName`; no `ngModel`), PrimeNG/Material según el código vigente. Init no decide un stack nuevo.
- EkuAssistant no vectoriza telemetría cruda; el corpus RAG es documentación/runbooks/postmortems aprobados por tenant.
- Hechos de producto no decididos aquí: estándar de accesibilidad (WCAG u otro), voz de marca más allá de la UI existente, pricing/licenciamiento para el portal.

## Brand Commitments

- Nombre de producto: **Ekumetrics** / **Ekumetrics Platform**. Asistente: **EkuAssistant AI**. Superficie de salud de plataforma: **E-Platform**.
- Recolector: **Ekumetrics Agent** (nunca «el agente» a secas si puede confundirse con investigación AIOps).
- Personalidad de producto: operacional, precisa, sin hype de productividad. Copy de UI en español.
- Vendor en usuarios de demo locales: Gradotech (`@gradotech.com`). No tratarlo como caso de cliente ni testimonio.

## Evidence on Hand

- Código y contratos: `ekumetrics-platform/` (portal Angular, API NestJS, OpenAPI) y `ekumetrics-agent/` (recolector Go).
- Arquitectura observada: `docs/aiops/current-architecture.md`, `ekumetrics-platform/docs/architecture.md`, `ekumetrics-platform/README.md`.
- Nomenclatura: `.cursor/rules/aiops-nomenclatura.mdc`.
- Demo local (no es prueba de cliente): operator/admin en realm `ekumetrics`; no hay testimonios, logos de clientes, benchmarks públicos ni casos de éxito que el diseño pueda citar. No fabricarlos.

## Product Principles

1. El operador en turno es el lector primario: densidad de datos, escaneo y confianza en la evidencia por encima de expresión visual.
2. Distinguir siempre recolector (Ekumetrics Agent) de investigador (AIOps Agent); Holmes no es el cerebro del producto.
3. La IA explica y cita fuentes autorizadas; no improvisar consultas, tenants ni salud cuando una fuente está caída.
4. Un solo producto: inventario, telemetría e investigación. El orquestador de AIOps Agents existe; no presentarlo como Holmes ni como remediación autónoma.
5. Preservar hechos de plataforma (tenancy, BFF, módulos opcionales) en cada superficie nueva; no diluirlos en una UI de «observability SaaS» genérica.
