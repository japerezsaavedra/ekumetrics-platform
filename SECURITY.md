# Seguridad

## Alcance

Este repositorio contiene el producto Ekumetrics Platform y un despliegue local reproducible. El Compose incluido no constituye una topología productiva endurecida.

## Reporte responsable

No publique vulnerabilidades, credenciales ni datos de clientes en issues públicos. Repórtelos por el canal privado de soporte de Gradotech acordado para el proyecto, incluyendo versión, componente, impacto, pasos mínimos de reproducción y cualquier mitigación aplicada.

## Requisitos de producción

- TLS 1.2 o superior en todos los accesos externos.
- mTLS para Agent → borde y asociación estricta `O=tenant`, `OU=site`, `CN=agent` antes de aceptar eventos.
- API, PostgreSQL, Keycloak, Prometheus, Loki y Grafana en redes privadas.
- Secretos fuera de Git y de imágenes; rotación y auditoría mediante gestor de secretos.
- Cifrado en reposo y copias de seguridad probadas.
- Credenciales únicas; quedan prohibidos los valores de ejemplo.
- MFA TOTP obligatorio para todas las cuentas humanas productivas; las identidades kiosk no usan cuentas humanas.
- Límites de petición, rate limiting y protección contra abuso en el borde.
- Registro de accesos y cambios administrativos sin almacenar tokens o claves.
- Política de parches y escaneo de imágenes/dependencias.

## Datos sensibles

Los envelopes no deben contener payloads de red, filas de bases de datos, mensajes de colas ni credenciales. `tags` se limita a metadatos operativos. Las claves de proveedores de IA nunca se devuelven al portal después de guardarse.

Las claves de proveedores de IA se cifran con AES-256-GCM antes de persistirse en PostgreSQL. `AI_SETTINGS_ENCRYPTION_KEY` es independiente de los secretos BFF, kiosk e ingesta, debe residir en un gestor externo y nunca almacenarse junto al backup de la base. Al leer una configuración heredada en texto claro, la API la vuelve a persistir cifrada; si falta la clave o falla la autenticación GCM, el servicio falla cerrado y no utiliza la credencial.

El perfil productivo no admite secretos inline. Un gestor externo debe materializar archivos de solo lectura en `SECRETS_DIR`; los entrypoints los convierten en variables únicamente dentro del proceso correspondiente. `agent-edge` recibe una clave de afirmación independiente y la API la verifica en tiempo constante junto con la identidad del certificado. Esto evita confiar solo en una cabecera de DN reenviada.

## Sesión del portal

El portal usa un patrón BFF: Authorization Code con PKCE, intercambio del código, renovación y revocación ocurren exclusivamente en la API. El navegador recibe solo un identificador opaco aleatorio de 256 bits en una cookie `HttpOnly`, `Secure`, `SameSite=Lax`, con prefijo `__Host-` en producción. Access, refresh e ID tokens se cifran con AES-256-GCM antes de persistirse en PostgreSQL y nunca se exponen a Angular, `localStorage` ni `sessionStorage`.

Toda mutación con sesión web exige un token CSRF ligado a la sesión, enviado en `X-CSRF-Token`, y un `Origin` que coincida exactamente con `PORTAL_PUBLIC_URL`. El logout elimina la sesión en PostgreSQL y solicita la revocación del refresh token en Keycloak. `BFF_SESSION_SECRET` debe tener al menos 32 caracteres aleatorios, residir en el gestor de secretos y rotarse mediante un procedimiento que asuma la invalidación de sesiones activas.

La continuidad de una consola de monitoreo no justifica tokens offline o access tokens sin vencimiento. El BFF mantiene access tokens cortos y los renueva mientras el portal permanece abierto; revocaciones, deshabilitaciones, inactividad y vencimiento absoluto siguen siendo efectivos.

## Autorización y aislamiento

La API aplica RBAC en una guardia global con política **deny-by-default**: todo endpoint autenticado debe declarar los roles permitidos. Ocultar elementos en Angular es únicamente una mejora de experiencia; nunca sustituye la autorización del servidor.

| Capacidad | operator | admin | viewer | pantalla |
|---|---:|---:|---:|---:|
| Dashboard y EkuAssistant | Sí | Sí | Sí | Solo dashboard asignado |
| Leer sitios y agentes propios | Sí | Sí | Sí | No |
| Administrar sitios, agentes, usuarios y pantallas | Sí | Sí, tenant propio | No | No |
| Crear, modificar o eliminar tenants | Sí | No | No | No |
| Configuración global de IA | Sí | No | No | No |
| Heartbeat de pantalla | No | No | No | Sí |

`operator` puede seleccionar un tenant administrado. `admin` y `viewer` ignoran cualquier tenant solicitado por cabecera o query y quedan fijados al claim `tenant` firmado por Keycloak. Todas las consultas y mutaciones administrativas vuelven a comprobar el tenant en PostgreSQL. Las identidades de pantalla requieren, además del rol técnico, una anotación explícita de endpoint y alcance por tenant, sitio y dashboard.

Cada tenant debe conservar al menos un administrador y un sitio. Un sitio no puede eliminarse mientras tenga agentes o pantallas activas; al cambiar su slug se invalidan las credenciales de sus pantallas para exigir una nueva activación con el alcance actualizado.

Las mutaciones sensibles crean primero un registro `*.requested` en `AuditLog` y lo cierran como `*.succeeded` o `*.failed`. La auditoría conserva actor, tenant objetivo, ruta y entidad, pero nunca copia contraseñas, tokens, claves ni el cuerpo completo de la solicitud.

## Valores de desarrollo

Los usuarios y contraseñas de demostración son públicos por diseño. Compose exige contraseñas y `INGEST_SHARED_KEY` explícitas, y se liga a `127.0.0.1` salvo configuración deliberada. Si se expone a una LAN, use credenciales únicas, firewall y datos no sensibles.

## Dependencias

La versión actual fija `deepmerge-ts` 8.0.0 mediante `overrides` porque Prisma 7.10.0 aún declara una versión afectada por CVE-2026-40345. El override se valida con generación Prisma, migraciones desde cero, tests, build y prueba E2E. No se debe retirar hasta que Prisma incorpore una versión corregida y `npm audit --omit=dev` permanezca limpio.

La adopción, estado y evidencia requerida de OWASP ASVS 5.0 nivel 2 se mantienen en [docs/security-asvs.md](docs/security-asvs.md). La existencia del baseline no equivale por sí sola a certificación.

## Pruebas dinámicas

`npm run security:test:dast` construye la imagen productiva del portal y ejecuta OWASP ZAP 2.17.0 fijado por digest. La compuerta rechaza cualquier riesgo bajo, medio o alto que no coincida exactamente con una aceptación versionada, responsable, ligada a Jira y no vencida. CI conserva los reportes JSON, Markdown y HTML durante 30 días.

Las aceptaciones vigentes viven en `security/dast/accepted-alerts.json`. No se permiten exclusiones por severidad, comodines ni supresiones sin vencimiento. Si una alerta aceptada deja de aparecer, la compuerta falla para obligar a retirar la excepción. Este baseline pasivo complementa, pero no sustituye, un escaneo autenticado de portal/API en staging ni una prueba de penetración independiente antes de GA.
