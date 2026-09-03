# Versiones, actualización y rollback

## Matriz de compatibilidad

La fuente verificable es `release/compatibility.json`; CI rechaza versiones desalineadas o una migración no declarada.

| Producto | Portal | API | Esquema máximo | Agent | Keycloak | PostgreSQL | Rollback soportado |
|---|---|---|---|---|---|---|---|
| 1.0.0 | 1.0.0 | 1.0.0 | `20260826231500_ai_conversations` | `>=1.4.0 <2.0.0` | 26.7.2 | 18 | No aplica: release inicial |

Portal y API deben desplegarse con la misma versión. No se admite mezclar tags aunque una prueba puntual parezca funcionar. Agent 1.4 mantiene el contrato OTLP y `/v1/ekms/events`; una versión mayor del agente exige nueva entrada de compatibilidad.

## Política de esquema

Las migraciones usan **expand-contract**:

1. expandir con tablas o columnas opcionales/aditivas;
2. desplegar código que pueda convivir con ambas representaciones;
3. migrar/backfill de forma observable;
4. contraer solo en una release posterior, después de retirar lectores antiguos.

`npm run release:check` bloquea `DROP`, `TRUNCATE`, renombres, cambios de tipo y `SET NOT NULL` no aprobados. Una excepción necesita comentario `ekumetrics: destructive-approved EKM-n`, revisión explícita, backup/restauración ensayada y actualización de la matriz. La anotación no convierte por sí sola una migración en reversible.

## Actualización

Una actualización productiva debe ejecutarse en ventana aprobada:

Desde el checkout firmado de la versión destino, ejecute:

```bash
npm run verify
npm run upgrade -- --recipient age1... --from VERSION_ORIGEN
```

Puede omitir `--from` cuando la API instalada responde en `http://127.0.0.1:3000/health/ready`. El destinatario también puede entregarse mediante `EKUMETRICS_BACKUP_RECIPIENT`; nunca incluya una identidad privada en el host.

El comando automatiza y detiene ante cualquier fallo en:

1. contrato de release y ruta origen → destino declarada;
2. preflight de la instalación activa;
3. backup cifrado obligatorio;
4. captura de tags y digests de las imágenes origen;
5. build inmutable de API y portal con la versión destino;
6. despliegue y `prisma migrate deploy` desde el entrypoint de API;
7. healthchecks, versión de `/health/ready` y evidencia con permisos restringidos en `release-state/`.

Después del comando, copie el backup fuera del host y ejecute pruebas de humo de login/refresh/logout, RBAC, ingesta idempotente, dashboard y pantalla. Para verificar el flujo OIDC completo contra el dominio productivo, use una cuenta de prueba temporal con el tenant y rol indicados:

```bash
KEYCLOAK_TEST_URL=https://auth.ejemplo.com \
KEYCLOAK_TEST_REDIRECT=https://api.ejemplo.com/v1/auth/callback \
KEYCLOAK_TEST_USER=usuario-prueba \
KEYCLOAK_TEST_PASSWORD='contraseña-temporal' \
KEYCLOAK_TEST_EXPECTED_TENANT=tenant-prueba \
KEYCLOAK_TEST_EXPECTED_ROLE=operator \
KEYCLOAK_TEST_REQUIRE_HTTPS=true \
node scripts/auth-code-smoke.mjs
```

El comando comprueba Authorization Code con PKCE S256, emisión y rotación de refresh token, logout y rechazo del refresh token revocado. No registre la contraseña ni conserve la cuenta después de aprobar la evidencia. Adjunte la evidencia de `release-state/` al registro de cambio aprobado; ese directorio es local y está excluido de Git.

No use `latest`, no edite migraciones publicadas y no ejecute `prisma migrate reset` en un entorno compartido.

## Rollback

Solo es válido si `rollbackTo` declara la versión origen y `schemaBackwardCompatible` es `true`. El rollback de aplicación reutiliza las imágenes inmutables retenidas y no revierte automáticamente el esquema aditivo.

```bash
npm run upgrade -- --rollback release-state/upgrade-FECHA.json \
  --confirm ROLLBACK-EKUMETRICS
```

El comando rechaza evidencia incompleta, una ruta no declarada, un esquema incompatible y cualquier imagen cuyo digest haya cambiado. La confirmación explícita evita una activación accidental, pero no reemplaza la aprobación del responsable de la ventana.

Si la matriz declara incompatibilidad de esquema, detenga el servicio y use el procedimiento completo de [restauración](operations.md#restauración-y-evidencia). Restaurar PostgreSQL revierte también datos creados después del backup y requiere autorización destructiva.

La versión 1.0.0 es la release inicial y no declara destino de rollback. El primer rollback real solo podrá cerrarse cuando exista una siguiente release compatible, se conserven ambas imágenes y se ejecute un simulacro completo.
