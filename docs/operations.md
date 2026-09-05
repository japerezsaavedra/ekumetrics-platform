# Operación

## Clasificación del despliegue

`infrastructure/docker/docker-compose.yml` es el despliegue local del producto. De fábrica publica solo en `127.0.0.1`. Para una prueba controlada en LAN, defina explícitamente `BIND_ADDR` y `PUBLIC_HOST` en `infrastructure/docker/.env` y aplique controles de firewall.

### Despliegue en Kubernetes (Lab)

Para despliegues en clusters k3s de laboratorio, existe un packaging adicional de Kubernetes con kustomize en `infrastructure/k8s/`. Este despliegue es complementario y está documentado en [infrastructure/k8s/README.md](../infrastructure/k8s/README.md). Los manifiestos de Kubernetes reutilizan las mismas configuraciones base (Prometheus, Loki, Tempo, OTEL, Grafana, Keycloak realm) que el despliegue de Compose.

**Importante**: El despliegue de Kubernetes es específico para entornos de laboratorio con recursos limitados. Para producción, siga usando Docker Compose con el override `docker-compose.production.yml` documentado más abajo.

El despliegue productivo debe añadir `infrastructure/docker/docker-compose.production.yml`. Este override sustituye `start-dev` por una imagen optimizada de Keycloak, usa una base de datos dedicada, elimina los usuarios de demostración, deshabilita Resource Owner Password Credentials, consume secretos montados y publica la entrada de agentes solo a través de mTLS. Requiere un proxy TLS que publique `PORTAL_PUBLIC_URL`, `API_PUBLIC_URL`, `GRAFANA_PUBLIC_URL` y `KEYCLOAK_PUBLIC_URL`, establezca correctamente `X-Forwarded-*` y solo permita alcanzar los puertos internos desde una red confiable. Los cuatro valores deben ser orígenes HTTPS sin ruta, query ni fragmento y usar hostnames distintos para preservar separación de origen; el portal los recibe en `runtime-config.js`, por lo que una misma imagen inmutable sirve para distintos entornos sin recompilar ni degradar HTTPS.

```bash
cp infrastructure/docker/.env.production.example infrastructure/docker/.env.production
# Configure orígenes, hostname de ingesta y rutas montadas; materialice secretos y certificados antes del preflight.
npm run preflight:production
npm run platform:install:production
```

El repositorio no emite certificados. El entorno aporta los certificados del proxy humano y la PKI de agentes. No exponga directamente `127.0.0.1:8080`; sin TLS frontal y cabeceras de proxy restringidas, el despliegue no cumple el perfil productivo.

### Secretos montados

`SECRETS_DIR` debe ser una ruta absoluta materializada por Vault, un CSI driver, systemd credentials u otro gestor equivalente. El `.env.production` contiene rutas y configuración no sensible, nunca valores secretos. Cree archivos regulares no vacíos, con `0400` o `0440`, y sin saltos de línea innecesarios:

| Archivo | Consumidor | Mínimo |
|---|---|---:|
| `postgres_password` | PostgreSQL de plataforma | 16 caracteres |
| `database_url` | API; DSN completo coherente con `postgres_password` | DSN válido |
| `keycloak_db_password` | PostgreSQL y Keycloak | 16 caracteres |
| `keycloak_admin_password` | bootstrap/admin de Keycloak y API | 16 caracteres |
| `grafana_admin_password` | Grafana | 16 caracteres |
| `ingest_shared_key` | borde/gateway y API | 32 caracteres aleatorios |
| `agent_edge_assertion_key` | borde mTLS y API | 32 caracteres aleatorios |
| `kiosk_token_secret` | API | 32 caracteres aleatorios |
| `bff_session_secret` | API | 32 caracteres aleatorios |
| `ai_settings_encryption_key` | API | 32 caracteres aleatorios e independiente |
| `holmes_upstream_key` | API/Holmes | 32 caracteres aleatorios |

El preflight comprueba presencia, tipo, permisos y longitud. Compose monta en cada contenedor únicamente los archivos que consume y los loaders fallan antes de arrancar si falta alguno. Una rotación exige actualizar el archivo de forma atómica y reiniciar coordinadamente los consumidores; no edite el archivo parcialmente en el lugar.

### PKI y mTLS de agentes

`AGENT_TLS_DIR` debe contener `ca.crt`, `server.crt` y `server.key`. La clave privada permite únicamente `0400` o `0440`. `server.crt` debe corresponder a la clave, estar emitido directamente por `ca.crt`, cubrir `AGENT_PUBLIC_HOST` mediante SAN y conservar al menos 30 días de vigencia al ejecutar preflight.

Cada certificado cliente debe incluir exactamente la identidad registrada del agente en su Subject:

```text
O=<tenant_id>, OU=<site_id>, CN=<agent_id>
```

Los valores admiten letras, números, punto, guion, guion bajo, dos puntos y slash; no use comas ni escapes en estos atributos. La CA de agentes no debe emitir certificados para otros usos. Mantenga CRL/OCSP y revocación en el componente PKI o balanceador elegido; el Nginx incluido valida cadena y vigencia durante el handshake, pero no distribuye por sí mismo una lista de revocación.

Producción publica `AGENT_GRPC_PORT` y `AGENT_HTTP_PORT` desde `AGENT_EDGE_BIND_ADDR`. El Collector y el gateway local pierden sus bindings de host. Ejecute `npm run security:test:mtls` para comprobar con certificados efímeros que el borde acepta un cliente firmado y rechaza uno sin certificado; antes de GA repita la prueba con la PKI y DNS reales.

Copie `.env.example` y sustituya todos los valores `change-me-*` antes de arrancar. No use las credenciales de demostración de Keycloak con datos reales.

## Preflight del host

Ejecute `npm run preflight` antes del primer despliegue local y `npm run preflight:production` antes de instalar o actualizar producción. La comprobación falla con código distinto de cero si detecta:

- menos de 4 CPU, 8 GiB de RAM o 20 GiB libres (ajustables con `EKUMETRICS_MIN_CPU`, `EKUMETRICS_MIN_RAM_GIB` y `EKUMETRICS_MIN_DISK_GIB`);
- una versión distinta de Node.js 24/npm 12, Docker/Compose ausentes o daemon inaccesible;
- variables obligatorias ausentes, secretos inline, archivos secretos débiles/inseguros o valores `change-me-*`/`example.com`;
- una configuración Compose inválida o puertos ocupados;
- reloj sin sincronización comprobable en producción;
- DNS inexistente, HTTPS inválido o certificados con menos de 30 días de vigencia.

La opción `--skip-port-check` existe solo para diagnosticar una instalación que ya está ejecutándose; no debe usarse como evidencia de preflight previo. Las advertencias y errores son deliberadamente accionables y nunca imprimen valores de secretos.

### Instalación reproducible

`npm run platform:install` y `npm run platform:install:production` ejecutan el preflight obligatorio, construyen y levantan Compose con `--wait`, y después comprueban los endpoints de API, Collector, portal y descubrimiento OIDC. El timeout predeterminado es de diez minutos y puede ajustarse directamente con `node scripts/install.mjs --timeout 900`.

Ante un fallo, el instalador devuelve un código distinto de cero y conserva contenedores y volúmenes para análisis. Use `npm run platform:logs`; no borre volúmenes durante el diagnóstico.

## Arranque y comprobación

```bash
cp infrastructure/docker/.env.example infrastructure/docker/.env
npm run platform:up
docker compose -f infrastructure/docker/docker-compose.yml ps
curl -f http://127.0.0.1:3000/health
curl -f http://127.0.0.1:3000/health/ready
curl -f http://127.0.0.1:4318/healthz
```

`/health` solo confirma proceso. `/health/ready` confirma PostgreSQL. El gateway no debe considerarse listo para ingesta si la API no está healthy.

## Migraciones

Las migraciones Prisma son acumulativas e inmutables después de publicarse. El contenedor de API ejecuta `prisma migrate deploy` antes de arrancar.

Antes de desplegar:

1. Realice copia consistente de PostgreSQL.
2. Ejecute la migración en staging con una copia representativa.
3. Revise bloqueos y duración.
4. Despliegue API y gateway compatibles con el nuevo esquema.
5. Verifique `/health/ready` y un lote de ingesta controlado.

Nunca edite una migración que ya haya llegado a un entorno compartido; cree una migración correctiva.

## Datos y copias de seguridad

Datos que requieren respaldo:

- PostgreSQL: tenants, usuarios, agentes, inventario, eventos, incidentes y configuración de IA.
- NATS JetStream: mensajes persistidos pendientes de procesar.
- Volúmenes de Prometheus, Loki, Tempo y Grafana según el RPO/RTO contratado.
- Alertmanager: silencios vigentes y estado operativo persistido en su volumen dedicado.
- Realm y configuración de Keycloak en una instalación productiva.

Las claves API de IA configuradas desde el portal se almacenan cifradas con AES-256-GCM en PostgreSQL. La clave maestra se entrega mediante `ai_settings_encryption_key`, fuera de la base y de sus backups; los proveedores que puedan aprovisionarse estáticamente deben preferir el gestor externo.

### Objetivos de recuperación

| Tipo de dato | RPO objetivo | RTO objetivo | Estrategia |
|---|---:|---:|---|
| PostgreSQL de plataforma | 15 minutos | 2 horas | Dump cifrado frecuente, almacenamiento externo versionado y restauración ensayada |
| Identidad Keycloak | 15 minutos | 2 horas | Dump cifrado de PostgreSQL junto al control plane |
| NATS JetStream | 15 minutos | 1 hora | Replicación/stream sources en producción; el backup lógico no reemplaza HA |
| Prometheus, Loki y Tempo | 24 horas | 4 horas | Object storage y snapshots definidos por el entorno; reconstrucción desde agentes cuando aplique |
| Alertmanager | 24 horas | 4 horas | Volumen persistente y reconstrucción controlada de silencios desde el registro de cambios |
| Configuración Grafana | 24 horas | 2 horas | Provisioning versionado y backup del volumen para objetos creados desde UI |

Los objetivos son máximos técnicos iniciales y deben ajustarse al SLA contractual. Un backup que permanezca únicamente en el mismo host no cuenta como protección.

### Backup cifrado del control plane

Instale [age](https://age-encryption.org/), genere y custodie la identidad fuera del host, y configure únicamente el destinatario público:

```bash
export EKUMETRICS_BACKUP_RECIPIENT='age1...'
npm run backup
```

El comando crea dumps PostgreSQL en formato custom, calcula SHA-256, genera un manifiesto versionado, cifra todo con age y elimina temporales aunque falle. En producción incluye las bases de plataforma y Keycloak; nunca incorpora contraseñas ni el archivo `.env`. La retención local predeterminada es de 30 días y puede ajustarse con `--retention-days`.

Copie después el archivo `.tar.age` a almacenamiento externo cifrado, inmutable y versionado. La clave privada de age debe residir en otro sistema y probarse mediante simulacros; no la almacene en este repositorio ni junto a los backups.

### Restauración y evidencia

La restauración reemplaza las bases actuales. Ejecútela únicamente en un simulacro, recuperación autorizada o host limpio, con una copia adicional del estado que será sustituido:

```bash
npm run restore -- \
  --backup /ruta/ekumetrics-backup-fecha.tar.age \
  --identity /ruta/identity.txt \
  --confirm RESTORE-EKUMETRICS
```

Antes de tocar servicios, el comando descifra en un directorio temporal, rechaza entradas inesperadas o path traversal, valida la versión del manifiesto y verifica cada SHA-256. Luego detiene consumidores, restaura plataforma y Keycloak con `pg_restore --exit-on-error`, levanta Compose esperando healthchecks y escribe evidencia JSON con duración y pérdida de datos estimada en `restore-evidence/`.

No se considera probado hasta ejecutar el procedimiento desde un host limpio, comprobar login, ingesta, dashboard y pantalla, y almacenar la evidencia junto al registro del simulacro. Si el comando falla durante la restauración, trate el entorno como parcialmente restaurado y no lo publique hasta completar el runbook.

## Observabilidad mínima

Monitorice:

- Estado y reinicios de contenedores.
- Latencia, códigos 4xx/5xx y tamaño de `/v1/ekms/events`.
- Crecimiento y edad de `AgentEvent`.
- `Agent.lastSeenAt` y agentes sin actividad.
- Espacio, WAL, conexiones y tiempo de consultas PostgreSQL.
- Targets de Prometheus y errores del Collector/Loki/Tempo.

Una tasa sostenida de `400` indica incompatibilidad de contrato. `401` indica clave interna desalineada. `403` indica inventario de agentes incorrecto o intento no autorizado.

Los SLIs, SLO y presupuesto de error se definen en [slo.md](slo.md). Grafana provisiona el dashboard **Ekumetrics · SLO y Error Budget** y Prometheus evalúa las reglas desde `prometheus/slo-rules.yml`.

### Respuesta a alertas SLO

1. Confirme en Prometheus que la alerta y sus dos ventanas siguen activas; no actúe solo sobre una notificación antigua.
2. Revise el dashboard SLO para separar caída total, errores 5xx, latencia y falta de ingesta.
3. Consulte `docker compose ps`, luego logs de API, gateway, PostgreSQL y Collector dentro de la misma ventana. No copie tokens ni payloads a Jira.
4. Si la API está caída, estabilice PostgreSQL y API antes de reiniciar consumidores. Si solo falla ingesta, preserve NATS y revise gateway/Collector antes de tocar almacenamiento.
5. Registre inicio, impacto, tenants afectados, mitigación y hora de recuperación. Una alerta crítica exige incidente y responsable.
6. Después de recuperar, confirme `/health/ready`, un evento controlado, dashboard actualizado y consumo de error budget. Abra seguimiento para la causa raíz.

Alertmanager local no envía notificaciones externas. Antes de producción configure un receptor autenticado y pruebe el enrutamiento de severidades `critical` y `warning`; no incluya secretos directamente en el archivo versionado.

### Gestión de alertas desde el portal

El contenedor Alertmanager se mantiene como fuente de verdad y conserva silencios en el volumen `alertmanager-data`. La API accede por la red interna mediante `ALERTMANAGER_URL`; el navegador nunca recibe esa dirección ni credenciales de infraestructura.

La ruta `/alertas` está limitada al rol operador y permite:

- consultar alertas activas, severidad, impacto, etiquetas e inhibiciones;
- revisar silencios activos y pendientes;
- crear silencios temporales de 5 minutos a 7 días con coincidencias exactas;
- finalizar un silencio antes de su vencimiento.

Todo silencio exige `alertname`, un motivo y un alcance derivado de las etiquetas de la alerta. El portal no permite expresiones regulares ni silencios globales. La creación y finalización quedan registradas en `AuditLog`. Un silencio evita notificaciones, pero no corrige la causa ni elimina la serie de Prometheus; debe estar asociado a una intervención o mantenimiento aprobado.

Después de cambiar la configuración de Alertmanager, valide el archivo y reinicie solo el contenedor correspondiente. Los cambios del módulo NestJS o Angular requieren reconstruir API y portal:

```bash
docker compose --env-file infrastructure/docker/.env \
  -f infrastructure/docker/docker-compose.yml up -d --build alertmanager platform-api portal-web
```

## Sesiones del portal

El portal mantiene activa una sesión BFF mediante un heartbeat independiente del refresco de métricas. Angular no almacena tokens OIDC: la API conserva access, refresh e ID tokens cifrados en PostgreSQL y entrega al navegador únicamente una cookie opaca `HttpOnly`. No existe cierre por inactividad mientras la pestaña permanezca abierta, la API y Keycloak sean alcanzables periódicamente y la cuenta continúe autorizada. La política no anula controles de seguridad: cierre manual, revocación administrativa, usuario deshabilitado o vencimiento máximo invalidan la sesión.

El realm local versionado fija un máximo de un año para facilitar desarrollo. El realm productivo fija 30 minutos de inactividad y 12 horas de vida máxima absoluta. La renovación automática evita cerrar una consola atendida por simple inactividad, pero no extiende el límite absoluto: al alcanzarlo se exige autenticación nueva. Esta desviación operativa frente a una sesión web convencional se limita a usuarios humanos supervisados; las pantallas permanentes no usan cuentas humanas ni el rol de Keycloak `kiosk`, sino una identidad de dispositivo independiente, restringida a un tenant, sitio y dashboard. Así se conserva monitoreo continuo sin convertir una sesión humana en indefinida.

Cada cuenta puede mantener hasta cinco sesiones BFF simultáneas. Al crear una sexta, la API elimina primero la sesión más antigua. Las sesiones vencidas o revocadas se purgan durante nuevos accesos y también al intentar reutilizarlas; una cookie sin registro activo carece de valor.

En producción, el primer acceso exige reemplazar la contraseña temporal y enrolar TOTP antes de entrar al portal. El operador debe completar el procedimiento de recuperación de factores con verificación de identidad equivalente antes de habilitar clientes reales; eliminar un factor sin esa comprobación no es un procedimiento aceptado.

`BFF_SESSION_SECRET` cifra con AES-256-GCM el material OIDC persistido y debe administrarse como secreto productivo. Toda mutación desde el portal incluye `X-CSRF-Token`; la API exige además que `Origin` coincida con `PORTAL_PUBLIC_URL`. Portal y API deben publicarse bajo hostnames del mismo sitio registrable para que `SameSite=Lax` preserve la sesión sin relajarla a `None`.

`AI_SETTINGS_ENCRYPTION_KEY` cifra separadamente las credenciales de proveedores de IA guardadas desde Configuración. Debe generarse de forma independiente, entregarse a la API desde el gestor de secretos y mantenerse fuera de PostgreSQL y de sus backups. Una rotación exige descifrar con la clave anterior y volver a guardar con la nueva dentro de una ventana controlada; reemplazarla directamente hace que la API falle cerrado al leer las credenciales existentes.

### Pantallas permanentes (modo kiosk)

1. En **Administración → Sitios**, cree una pantalla y seleccione su sitio y dashboard.
2. Copie el identificador y la credencial. La credencial se muestra una sola vez.
3. En el equipo de visualización abra `/kiosk/activar`, ingrese ambos valores y active la pantalla.
4. Compruebe que el estado cambie a **Conectada** después del primer heartbeat.

El navegador conserva únicamente la credencial opaca del dispositivo y recibe tokens de acceso de diez minutos. El servidor almacena solo el hash de esa credencial. La API registra enrolamiento, renovación, heartbeat, cambio de alcance, rotación y revocación en `AuditLog`. El portal renueva tres minutos antes del vencimiento y también al realizar una petición si los temporizadores del navegador fueron suspendidos. La credencial se rota de forma explícita desde Administración para que una respuesta perdida o un reintento concurrente nunca deje una pantalla desactivada.

Para retirar una pantalla, use **Revocar**. La API consulta el estado y la versión de la identidad en cada petición, por lo que un token aún no vencido deja de funcionar inmediatamente. Una rotación o un cambio de sitio/dashboard también invalida los tokens emitidos previamente.

`KIOSK_TOKEN_SECRET` es independiente de Keycloak y de `INGEST_SHARED_KEY`; debe ser aleatoria, tener al menos 32 caracteres y residir en el gestor de secretos. Rotarla globalmente invalida todas las sesiones de pantalla y exige volver a activarlas con sus credenciales vigentes.

En un Keycloak existente, `--import-realm` no reemplaza automáticamente la configuración ya creada: aplique los cambios de realm mediante un procedimiento administrado y auditable.

## Retención

La política predeterminada está acotada y debe revisarse contra el contrato de cada instalación:

| Almacén | Límite predeterminado | Comportamiento |
|---|---:|---|
| `AgentEvent` en PostgreSQL | 30 días | La API elimina por hora hasta 20 lotes de 1.000 eventos vencidos |
| Conversaciones de EkuAssistant en PostgreSQL | 90 días desde la última actividad | La API elimina sesiones vencidas y sus investigaciones en cascada, en lotes de hasta 500 |
| Prometheus | 30 días o 10 GB | Se aplica el límite que ocurra primero |
| Loki | 30 días | El Compactor elimina chunks mediante retención TSDB con dos horas de demora |
| Tempo | 30 días | Scheduler y worker de compaction eliminan bloques; EkuAssistant consulta como máximo 24 horas por petición |
| NATS JetStream | 10 GB en disco y 256 MB en memoria | JetStream rechaza nuevas escrituras cuando no puede respetar el límite |
| Backups locales cifrados | 30 días | `npm run backup` aplica retención por nombre y antigüedad |

`EVENT_RETENTION_DAYS=0` deshabilita explícitamente la purga de eventos y genera una advertencia al arrancar. En producción mantenga un valor contractual, respalde antes de reducirlo y recuerde que la eliminación no equivale a archivo. `EVENT_RETENTION_BATCH_SIZE` y `EVENT_RETENTION_MAX_BATCHES` limitan el trabajo por ciclo para evitar bloqueos prolongados.

`AI_INQUIRY_RETENTION_DAYS` controla la retención móvil de EkuAssistant entre 1 y 3.650 días. `AI_INQUIRY_RETENTION_INTERVAL_MS` define la frecuencia del worker y `AI_INQUIRY_RETENTION_BATCH_SIZE` limita el trabajo de cada ciclo. Reducir la ventana afecta tanto el historial visible como la evidencia auditable; debe aprobarse de acuerdo con la política contractual y de privacidad.

`AI_EMBEDDING_URL` apunta al servicio de embeddings y `AI_EMBEDDING_MODEL` fija el modelo usado tanto al indexar como al consultar. El valor soportado por defecto es `qwen3-embedding:0.6b` (1.024 dimensiones); cambiarlo exige una migración de dimensión y reindexación completa, nunca mezclar vectores de modelos distintos. La indexación falla si el modelo no responde; las consultas degradan a full-text y muestran la menor cobertura correspondiente.

Tempo limita además cada respuesta a 100 trazas, cada spanset a 10 spans y cada expresión TraceQL a 8 KiB. La Retrieval API aplica límites más estrictos: 20 trazas, tres spans por spanset y 24 horas. El volumen `tempo-data` y backend local son válidos para el despliegue monolítico de un solo nodo; antes de ofrecer alta disponibilidad o retención contractual, configure S3/GCS/Azure, cifrado, lifecycle, capacidad y restauración probada. No comparta el mismo directorio local entre réplicas.

Prometheus publica ejecuciones, fallos y cantidad eliminada. Una purga fallida no se oculta: queda en logs y dispara `EkumetricsEventRetentionFailed` o `EkumetricsEventRetentionStalled`.

### Respuesta a capacidad y disco lleno

Node Exporter observa el filesystem del host mediante un montaje de solo lectura. Alertas sostenidas se generan al quedar menos de 15 % y 5 % disponible.

1. Con menos de 15 %, congele despliegues y trabajos de IA no esenciales. Determine qué volumen crece con `docker system df` y métricas de Prometheus; no borre datos todavía.
2. Verifique que la retención de eventos, Loki, Tempo y Prometheus esté funcionando. Un cambio reciente de volumen puede indicar un loop de errores o cardinalidad inesperada.
3. Con menos de 5 %, declare incidente crítico. Preserve PostgreSQL y NATS, detenga productores opcionales y amplíe el disco o volumen.
4. No ejecute `docker system prune`, `down -v`, borrado manual de WAL, chunks o bloques TSDB. Esas acciones pueden producir pérdida o corrupción no recuperable.
5. Si una escritura fue rechazada, confirme explícitamente la recuperación: evento controlado persistido, `lastSeenAt` actualizado, targets Prometheus activos, Loki aceptando logs y una traza OTLP visible en Tempo/Grafana.
6. Registre la ventana afectada como posible pérdida de telemetría y compárela con el buffer/reintentos de los agentes. No cierre el incidente solo porque liberó espacio.

La topología local usa un solo disco y no ofrece tolerancia a fallos. Producción debe separar o dimensionar volúmenes según carga, alertar desde un sistema externo y usar almacenamiento de objetos/replicación cuando el SLA lo requiera.

## Rotación de la clave interna

`INGEST_SHARED_KEY` debe ser aleatoria y tener al menos 32 bytes. La API y el gateway deben recibir el mismo valor desde el gestor de secretos. La versión actual requiere reiniciar ambos componentes coordinadamente durante la rotación.

## Recuperación y parada

```bash
npm run platform:logs
npm run platform:down
```

`platform:down` conserva volúmenes, incluido `nats-data`. No use `down -v` salvo que quiera eliminar deliberadamente todos los datos del despliegue local.

## Diagnóstico para soporte

Genere un directorio revisable sin adjuntar manualmente `.env`, dumps ni archivos completos del host:

```bash
npm run diagnostics
```

La herramienta recopila versiones, recursos, estados de salud, plantilla Compose sin interpolar y hasta 500 líneas de los últimos 30 minutos por contenedor. Redacta JWT, Bearer tokens, claves de proveedores, contraseñas, cookies, credenciales en URL, correos, IP distintas de loopback y rutas personales. Cada archivo queda limitado a 5 MiB, con permisos restrictivos y checksum en el manifiesto.

No genera un archivo compartible automáticamente. Una persona autorizada debe abrir el directorio, eliminar contenido innecesario y confirmar que no haya datos del cliente. Solo después:

```bash
node scripts/diagnostics.mjs \
  --pack /ruta/al/ekumetrics-diagnostics-fecha \
  --confirm REVIEWED
```

El empaquetador rechaza symlinks y vuelve a escanear todos los archivos. Comparta el `.tar.gz` únicamente por el canal privado acordado y elimínelo conforme a la política del caso. La redacción automática reduce riesgo, pero no sustituye la revisión humana.
