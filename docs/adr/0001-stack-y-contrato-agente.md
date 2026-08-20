# ADR-0001 — Stack de la plataforma y contrato con Ekumetrics Agent

- Estado: aceptado
- Fecha: 2026-08-20
- Producto: Ekumetrics Platform

## Contexto

El documento base de producto define Angular, NestJS, PostgreSQL y motores open source (Prometheus, Loki, Alertmanager, Grafana). El agente en `agent-sap` ya existe y no espera las APIs genéricas del Apéndice B (`POST /events`, enrolamiento HTTP). Empuja un contrato propio.

## Decisión

1. Stack de producto: NestJS 11, Angular 22 standalone, PostgreSQL (pgvector), Prisma 7.
2. Laboratorio local con Docker Compose. On-premise y administrado reutilizan la misma base más adelante.
3. El contrato de borde del agente es la fuente de verdad de ingesta:
   - Eventos: `POST /v1/ekms/events` (JSON array del envelope, gzip opcional).
   - Telemetría: OTLP gRPC `:4317` y HTTP `:4318`, incluyendo `/v1/logs`.
   - Identidad: `tenant_id`, `site_id`, `agent_id` (YAML del agente; no se fía solo del body).
   - Transporte: TLS 1.2 y mTLS (`caFile`, `certFile`, `keyFile`). Laboratorio: `insecure: true`.
4. Alloy, Wazuh, Tempo, Mimir HA e IA quedan fuera de la Fase 0.
5. El código vive en `apps/`. Un despliegue Kubernetes, si hace falta, irá en `infrastructure/kubernetes`.

## Consecuencias

- La Fase 1 debe implementar `/v1/ekms/events` y el receptor OTLP antes que enrolamiento o heartbeat HTTP.
- Un agente de laboratorio apunta a `export.otlp.endpoint: "<lab>:4317"` sin cambios en `agent-sap`.
- El Apéndice B se versiona encima de este contrato, no al revés.
