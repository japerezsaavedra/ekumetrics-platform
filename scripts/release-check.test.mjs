import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  destructiveStatements,
  validateProductionKeycloak,
  validateReleaseState,
} from './release-check.mjs';

test('detecta migraciones destructivas pero ignora comentarios', () => {
  assert.equal(destructiveStatements('-- DROP TABLE legacy;\nALTER TABLE x ADD COLUMN y TEXT;').length, 0);
  assert.ok(destructiveStatements('ALTER TABLE x DROP COLUMN y;').length > 0);
  assert.ok(destructiveStatements('ALTER TABLE x ALTER COLUMN y SET NOT NULL;').length > 0);
});

test('exige versiones alineadas y última migración declarada', () => {
  const errors = validateReleaseState({
    root: { version: '1.0.0' },
    api: { version: '1.0.0' },
    portal: { version: '1.0.1' },
    compatibility: {
      currentRelease: '1.0.0',
      releases: { '1.0.0': { databaseMigration: 'old' } },
    },
    migrations: ['old', 'new'],
  });
  assert.equal(errors.length, 2);
});

test('protege el perfil Keycloak productivo contra regresiones', () => {
  const compose = readFileSync('infrastructure/docker/docker-compose.production.yml', 'utf8');
  const realm = JSON.parse(
    readFileSync('infrastructure/docker/keycloak/ekumetrics-production-realm.json', 'utf8'),
  );
  assert.deepEqual(validateProductionKeycloak({ compose, realm }), []);

  const insecureCompose = compose
    .replace('["start", "--optimized", "--import-realm"]', '["start-dev", "--import-realm"]')
    .replace('KC_HOSTNAME_STRICT: "true"', 'KC_HOSTNAME_STRICT: "false"');
  const insecureRealm = structuredClone(realm);
  insecureRealm.users = [{ username: 'demo' }];
  insecureRealm.clients[0].directAccessGrantsEnabled = false;
  insecureRealm.clients[0].attributes['pkce.code.challenge.method'] = 'plain';

  const errors = validateProductionKeycloak({
    compose: insecureCompose,
    realm: insecureRealm,
  });
  assert.ok(errors.some((error) => error.includes('start-dev')));
  assert.ok(errors.some((error) => error.includes('KC_HOSTNAME_STRICT')));
  assert.ok(errors.some((error) => error.includes('usuarios precargados')));
  assert.ok(errors.some((error) => error.includes('Password Grant')));
  assert.ok(errors.some((error) => error.includes('PKCE S256')));
});
