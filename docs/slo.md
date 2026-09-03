# Objetivos de nivel de servicio

## Alcance y ventana

Estos SLO son objetivos técnicos iniciales de Ekumetrics Platform, medidos sobre una ventana móvil de 30 días. No sustituyen el SLA contractual. El dashboard provisionado **Ekumetrics · SLO y Error Budget** es la fuente operativa para revisar cumplimiento y consumo.

| Servicio | SLI | Objetivo de 30 días | Fuente |
|---|---|---:|---|
| Disponibilidad de API | Fracción de scrapes exitosos multiplicada por solicitudes sin respuesta 5xx | 99,9 % | `up{job="platform-api"}` y `ekumetrics_http_requests_total` |
| Latencia de API | Fracción de solicitudes completadas en 500 ms o menos | 95 % | `ekumetrics_http_request_duration_seconds` |
| Frescura de ingesta | Fracción de agentes registrados con `lastSeenAt` dentro de cinco minutos | 99 % | `ekumetrics_agents_fresh / ekumetrics_agents_total` |

Healthchecks y el propio scrape de métricas quedan fuera del volumen HTTP para evitar que el monitoreo oculte errores de tráfico real. Las métricas no incluyen correos, tokens, tenant IDs, agent IDs ni URLs con identificadores; las rutas se obtienen desde metadata de NestJS para limitar cardinalidad.

## Presupuesto de error

Para disponibilidad de 99,9 %, el presupuesto mensual es 0,1 %, aproximadamente 43 minutos y 49 segundos en 30 días. `ekumetrics:api_error_budget:consumed_ratio30d` expresa cuánto se ha consumido: `1` equivale al 100 % del presupuesto.

Las alertas de burn rate usan dos ventanas para evitar ruido:

- consumo rápido: 14,4 veces el presupuesto en ventanas de 5 minutos y 1 hora;
- consumo sostenido: 6 veces el presupuesto en ventanas de 30 minutos y 6 horas.

Una alerta de burn rate no significa necesariamente que el SLO ya se incumplió; significa que, si continúa la tasa actual, se agotará el presupuesto dentro de la ventana.

## Decisiones operativas

- Si el presupuesto supera 100 %, se congelan cambios no esenciales que puedan reducir fiabilidad.
- Un despliegue solo puede continuar con una alerta crítica activa si existe una excepción documentada con responsable y mitigación.
- Reinicios de Prometheus o API no deben interpretarse como reinicio contractual del SLO; Prometheus conserva las series en su volumen y maneja resets de counters.
- Los objetivos deben revisarse tras el piloto y cada cambio de SLA, volumen o arquitectura.

Consulte la respuesta operativa en [operations.md](operations.md#respuesta-a-alertas-slo).
