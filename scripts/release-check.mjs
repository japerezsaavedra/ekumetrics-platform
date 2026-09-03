#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DESTRUCTIVE_SQL = [
  /\bDROP\s+(?:TABLE|COLUMN|TYPE|INDEX|SCHEMA)\b/i,
  /\bTRUNCATE\b/i,
  /\bRENAME\s+(?:COLUMN|TO)\b/i,
  /\bALTER\s+(?:TABLE\s+\S+\s+)?(?:ALTER\s+COLUMN\s+\S+\s+)?TYPE\b/i,
  /\bSET\s+NOT\s+NULL\b/i,
];

export function destructiveStatements(sql) {
  const withoutComments = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return DESTRUCTIVE_SQL.filter((pattern) => pattern.test(withoutComments)).map(
    (pattern) => pattern.source,
  );
}

export function validateReleaseState({ root, api, portal, compatibility, migrations }) {
  const errors = [];
  if (root.version !== api.version || root.version !== portal.version) {
    errors.push('Las versiones root, API y portal deben coincidir.');
  }
  if (compatibility.currentRelease !== root.version) {
    errors.push('compatibility.currentRelease debe coincidir con package.json.');
  }
  const release = compatibility.releases?.[root.version];
  if (!release) errors.push(`Falta la versión ${root.version} en la matriz de compatibilidad.`);
  if (release && release.databaseMigration !== migrations.at(-1)) {
    errors.push('La matriz no apunta a la última migración Prisma.');
  }
  return errors;
}

function serviceBlock(compose, service) {
  const heading = `  ${service}:\n`;
  const start = compose.indexOf(heading);
  if (start === -1) return '';
  const tail = compose.slice(start + heading.length);
  const end = tail.search(/^  [a-zA-Z0-9_-]+:|^volumes:/m);
  return heading + (end === -1 ? tail : tail.slice(0, end));
}

export function validateProductionKeycloak({ compose, realm }) {
  const errors = [];
  const database = serviceBlock(compose, 'keycloak-db');
  const keycloak = serviceBlock(compose, 'keycloak');
  const client = realm.clients?.find((candidate) => candidate.clientId === 'portal-web');
  const totp = realm.requiredActions?.find((action) => action.alias === 'CONFIGURE_TOTP');

  const requireCompose = (condition, message) => {
    if (!condition) errors.push(`Keycloak productivo: ${message}`);
  };
  const requireRealm = (condition, message) => {
    if (!condition) errors.push(`Realm productivo: ${message}`);
  };

  requireCompose(Boolean(keycloak), 'falta el servicio keycloak.');
  requireCompose(!/\bstart-dev\b/.test(keycloak), 'no se permite start-dev.');
  requireCompose(
    /command:\s*\[\s*["']start["']\s*,\s*["']--optimized["']/.test(keycloak),
    'debe iniciar con start --optimized.',
  );
  requireCompose(
    /image:\s*postgres:18(?:-|\s|$)/m.test(database),
    'falta PostgreSQL 18 dedicado para la identidad.',
  );
  requireCompose(/KC_DB:\s*postgres\s*$/m.test(keycloak), 'KC_DB debe ser postgres.');
  requireCompose(
    /KC_DB_URL:\s*jdbc:postgresql:\/\/keycloak-db:5432\/keycloak\s*$/m.test(keycloak),
    'la base debe apuntar al servicio keycloak-db.',
  );
  requireCompose(
    /KC_HOSTNAME:\s*\$\{KEYCLOAK_PUBLIC_URL:\?[^}]+\}\s*$/m.test(keycloak),
    'KC_HOSTNAME debe exigir KEYCLOAK_PUBLIC_URL.',
  );
  requireCompose(
    /KC_HOSTNAME_STRICT:\s*["']true["']\s*$/m.test(keycloak),
    'KC_HOSTNAME_STRICT debe estar activo.',
  );
  requireCompose(
    /KC_PROXY_HEADERS:\s*xforwarded\s*$/m.test(keycloak),
    'solo se admiten cabeceras xforwarded del proxy confiable.',
  );
  requireCompose(
    /["']127\.0\.0\.1:8080:8080["']/.test(keycloak),
    'el puerto HTTP debe quedar limitado al loopback del host.',
  );
  requireCompose(
    /ekumetrics-production-realm\.json/.test(keycloak),
    'debe importar el realm productivo.',
  );

  requireRealm(realm.sslRequired === 'external', 'sslRequired debe ser external.');
  requireRealm(
    !Array.isArray(realm.users) || realm.users.length === 0,
    'no debe contener usuarios precargados.',
  );
  requireRealm(realm.bruteForceProtected === true, 'la protección de fuerza bruta debe estar activa.');
  requireRealm(realm.revokeRefreshToken === true, 'la rotación de refresh tokens debe estar activa.');
  requireRealm(realm.refreshTokenMaxReuse === 0, 'un refresh token no debe poder reutilizarse.');
  requireRealm(Boolean(client), 'falta el cliente portal-web.');
  if (client) {
    requireRealm(client.publicClient === true, 'portal-web debe ser un cliente público.');
    requireRealm(client.standardFlowEnabled === true, 'Authorization Code debe estar activo.');
    requireRealm(client.implicitFlowEnabled === false, 'Implicit Flow debe estar desactivado.');
    requireRealm(
      client.directAccessGrantsEnabled === true,
      'Password Grant debe estar activo para el login del portal.',
    );
    requireRealm(
      client.attributes?.['pkce.code.challenge.method'] === 'S256',
      'PKCE S256 debe ser obligatorio.',
    );
    requireRealm(
      client.redirectUris?.length === 1 &&
        client.redirectUris[0] === '${API_PUBLIC_URL}/v1/auth/callback',
      'el redirect permitido debe ser únicamente el callback de la API.',
    );
    requireRealm(
      client.webOrigins?.length === 1 && client.webOrigins[0] === '${PORTAL_PUBLIC_URL}',
      'el origen permitido debe ser únicamente el portal configurado.',
    );
  }
  requireRealm(
    totp?.enabled === true && totp.defaultAction === true,
    'TOTP debe estar habilitado como acción predeterminada.',
  );

  return errors;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
  const migrationsRoot = 'apps/platform-api/prisma/migrations';
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const errors = validateReleaseState({
    root: readJson('package.json'),
    api: readJson('apps/platform-api/package.json'),
    portal: readJson('apps/portal-web/package.json'),
    compatibility: readJson('release/compatibility.json'),
    migrations,
  });
  errors.push(
    ...validateProductionKeycloak({
      compose: readFileSync('infrastructure/docker/docker-compose.production.yml', 'utf8'),
      realm: readJson('infrastructure/docker/keycloak/ekumetrics-production-realm.json'),
    }),
  );

  for (const migration of migrations) {
    const path = join(migrationsRoot, migration, 'migration.sql');
    const sql = readFileSync(path, 'utf8');
    const destructive = destructiveStatements(sql);
    const approved = /^--\s*ekumetrics:\s*destructive-approved\s+EKM-\d+/im.test(sql);
    if (destructive.length && !approved) {
      errors.push(
        `${basename(join(migrationsRoot, migration))} contiene SQL destructivo sin aprobación EKM documentada.`,
      );
    }
  }

  if (errors.length) {
    for (const error of errors) console.error(`✗ ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `✓ Release ${readJson('package.json').version}: versiones, matriz, ${migrations.length} migraciones y perfil Keycloak productivo compatibles.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
