# Baseline de seguridad OWASP ASVS

## Objetivo y criterio

Ekumetrics adopta **OWASP ASVS 5.0.0 nivel 2** como baseline de salida a producción. La referencia normativa es la publicación estable de OWASP, no la rama `master` ni una copia reinterpretada en este repositorio.

Un control solo puede figurar como `Verificado` cuando existe evidencia repetible (prueba, configuración inspeccionable, resultado de escaneo o acta de revisión manual). Implementación sin verificación se registra como `Pendiente`; `No aplica` exige justificación revisada. Los hallazgos críticos o altos bloquean GA salvo aceptación de riesgo escrita, con responsable, mitigación y fecha de vencimiento.

## Trazabilidad inicial

Esta tabla es el índice vivo por capítulo. No afirma conformidad global: ASVS L2 contiene controles que requieren revisión manual y pruebas dinámicas además de análisis automatizado.

| Capítulo ASVS 5.0 | Estado | Evidencia principal | Trabajo pendiente |
|---|---|---|---|
| V1 Encoding and Sanitization | Pendiente | DTOs y validación global de NestJS | revisión requisito por requisito e inyección dinámica |
| V2 Validation and Business Logic | Pendiente | validadores, invariantes tenant/sitio | abuso de flujos, límites y concurrencia |
| V3 Web Frontend Security | Verificado parcial | Angular, cookie BFF `__Host-`/HttpOnly/Secure/SameSite y CSRF ligado a origen | cerrar requisito CSP `base-uri 'none'` y revisión DOM completa |
| V4 API and Web Service | Pendiente | OpenAPI, DTOs, RBAC global | fuzzing y validación completa de contrato |
| V5 File Handling | No aplica parcial | el producto no acepta uploads de cliente | confirmar exports, backups y diagnósticos por requisito |
| V6 Authentication | Verificado parcial | política mínima de 15 caracteres sin reglas de composición, bloqueo progresivo, credenciales iniciales temporales y TOTP obligatorio en producción | contraseñas comprometidas, recuperación y ciclo de vida seguro de factores |
| V7 Session Management | Verificado parcial | BFF stateful, identificador opaco CSPRNG, tokens cifrados, 30 min de inactividad, máximo absoluto de 12 h, refresh rotado y logout visible | sesiones concurrentes, terminación administrativa y reautenticación sensible |
| V8 Authorization | Verificado parcial | modelo documentado, guard deny-by-default, enforcement servidor y pruebas negativas multi-tenant/kiosk | completar restricciones de campo y ampliar pruebas a cada recurso nuevo |
| V9 Self-contained Tokens | Verificado parcial | firma/MAC, algoritmos RS256/HS256, issuer, audiencia, vigencia y tipo probados | completar controles de ciclo de vida no cubiertos |
| V10 OAuth and OIDC | Verificado parcial | Authorization Code + PKCE S256 ejecutado por el BFF, state cifrado, callbacks exactos, refresh y logout; implicit/password deshabilitados | HTTPS equivalente a producción y controles restantes del capítulo |
| V11 Cryptography | Verificado parcial | AES-256-GCM para sesiones y credenciales de IA, pruebas de manipulación y backups cifrados con age | inventario criptográfico, procedimiento completo de rotación y gestión externa de claves |
| V12 Secure Communication | Verificado parcial | borde Agent mTLS TLS 1.2/1.3, prueba negativa sin certificado y binding DN→identidad | evidencia con certificados y dominios reales; HTTPS humano y revisión requisito por requisito |
| V13 Configuration | Verificado parcial | preflight, secretos montados obligatorios, rechazo de secretos inline y puertos de ingesta internos sin publicación | hardening de host, gestor externo real y allowlist de egress |
| V14 Data Protection | Pendiente | minimización de envelopes y diagnóstico redactado | clasificación, residencia, borrado y privacidad formal |
| V15 Secure Coding and Architecture | Pendiente | CI, revisión de migraciones y dependencias fijadas | threat model y revisión arquitectónica independiente |
| V16 Security Logging and Error Handling | Verificado parcial | auditoría administrativa, métricas y logs redactados | cobertura de eventos de seguridad y pruebas de alertas |
| V17 WebRTC | No aplica | Ekumetrics no implementa WebRTC | revalidar si cambia el alcance del producto |

## Controles automáticos obligatorios

El workflow `security.yml` corre en pull requests, `main`, semanalmente y bajo demanda:

- Gitleaks 8.30.1 inspecciona el historial completo y redacta cualquier hallazgo;
- CodeQL v4 ejecuta SAST JavaScript/TypeScript con consultas `security-extended`;
- Trivy Action 0.36.0 instala Trivy 0.74.0 y analiza dependencias, IaC/configuración, secretos y las imágenes productivas;
- `npm audit --omit=dev --audit-level=high` permanece en el CI funcional para ambos paquetes;
- Dependabot propone actualizaciones semanales de npm y GitHub Actions.
- OWASP ZAP 2.17.0, fijado por digest, escanea dinámicamente la imagen endurecida del portal y conserva reportes JSON/Markdown/HTML como evidencia.

Los escaneos de componentes fallan ante severidad `HIGH` o `CRITICAL`. DAST es más estricto: bloquea cualquier riesgo bajo, medio o alto que no coincida con una aceptación exacta, responsable y no vencida. `ignore-unfixed` evita una excepción imposible de resolver, pero no constituye aceptación: el hallazgo debe registrarse y reevaluarse semanalmente.

Las excepciones DAST se registran en `security/dast/accepted-alerts.json`. La política rechaza excepciones incompletas, vencidas o que ya no aparecen. La presencia de la API `bypassSecurityTrustHtml` dentro del runtime de Angular se documenta como falso positivo; el código del producto no la invoca y el contenido Markdown se procesa con DOMPurify más la sanitización de Angular. `style-src 'unsafe-inline'` permanece como deuda temporal por estilos calculados de Angular Material y telemetría, sin relajar `script-src`.

### Excepciones del detector

`.trivyignore.yaml` solo admite excepciones con alcance, evidencia y vencimiento. La excepción vigente para `CVE-2025-59250` se limita al JAR `mssql-jdbc-13.2.1.jre11.jar` de Keycloak: su SHA-256 coincide con el artefacto corregido de Maven Central, pero Trivy 0.74.0 interpreta la versión genérica `13.2.1` de su POM interno. Expira el 30 de septiembre de 2026 para forzar revisión; no autoriza otra versión, ruta o CVE.

## Evidencia para una release

Antes de GA, Seguridad debe adjuntar a la release:

1. registro de los 253 controles heredados por L2 (70 L1 + 183 L2) con estado individual, evidencia y responsable;
2. resultados verdes del workflow de seguridad en el commit exacto;
3. revisión manual de controles no automatizables, incluyendo sesión, autorización, privacidad y comunicaciones;
4. informe DAST/fuzzing sobre una instalación equivalente a producción;
5. lista vacía de altos/críticos abiertos o aceptaciones de riesgo vigentes y firmadas.

El registro requisito por requisito vive en [`security/asvs/controls.json`](../security/asvs/controls.json) y su integridad se valida en CI. La tabla por capítulos resume el programa, pero no sustituye ese registro ni permite declarar conformidad prematuramente.

## Baseline de autenticación comprobada

El BFF acepta exclusivamente Authorization Code con PKCE S256, conserva `state` y verifier en una transacción cifrada de diez minutos e intercambia el código desde el servidor. Los realms versionados deshabilitan Implicit y Resource Owner Password Credentials, registran el callback exacto del API y post-logout del portal y rotan refresh tokens sin permitir reutilización. La API valida tokens Keycloak firmados únicamente con RS256 contra el JWKS preconfigurado y exige issuer, audiencia `portal-web` y tipo `Bearer`; los tokens kiosk usan un emisor separado y únicamente HS256.

Producción no precarga usuarios. Keycloak exige al menos 15 caracteres, permite cualquier composición hasta 128 caracteres, impide usar el nombre de usuario y aplica protección contra fuerza bruta después de cinco fallos, con espera incremental de 60 segundos y máximo de 15 minutos. Las altas administrativas generan 18 bytes con CSPRNG, entregan la contraseña una sola vez como credencial temporal y fuerzan `UPDATE_PASSWORD` y `CONFIGURE_TOTP` en el primer acceso productivo. El realm productivo exige TOTP HMAC-SHA256 de seis dígitos y 30 segundos; el entorno local de demostración no exige enrolamiento. Recuperación de factores, identity proofing y terminación coordinada de sesiones continúan pendientes antes de conformidad L2 completa.
