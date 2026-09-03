import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseEnv, validateConfiguration, validateSecretDirectory } from './preflight.mjs';

test('parseEnv ignora comentarios y conserva valores con igual', () => {
  assert.deepEqual(parseEnv('# comentario\nA=uno=dos\nB="tres"\n'), { A: 'uno=dos', B: 'tres' });
});

test('produccion rechaza placeholders, URLs sin TLS y claves cortas', () => {
  const errors = validateConfiguration({
    BIND_ADDR: '127.0.0.1',
    SECRETS_DIR: 'relative/secrets',
    AGENT_TLS_DIR: 'relative/tls',
    AGENT_EDGE_BIND_ADDR: '0.0.0.0',
    AGENT_PUBLIC_HOST: 'ingest.example.com',
    PORTAL_PUBLIC_URL: 'http://monitoring.example.com',
    API_PUBLIC_URL: 'https://api.example.com/path',
    GRAFANA_PUBLIC_URL: 'https://grafana.example.com',
    KEYCLOAK_PUBLIC_URL: 'https://auth.example.com',
    POSTGRES_PASSWORD: 'change-me-postgres',
    KEYCLOAK_DB_PASSWORD: 'change-me-db',
    KEYCLOAK_ADMIN_USERNAME: 'admin',
    KEYCLOAK_ADMIN_PASSWORD: 'change-me-admin',
    GRAFANA_ADMIN_PASSWORD: 'change-me-grafana',
    INGEST_SHARED_KEY: 'corta',
    KIOSK_TOKEN_SECRET: 'corta',
    BFF_SESSION_SECRET: 'corta',
    AI_SETTINGS_ENCRYPTION_KEY: 'corta',
    HOLMES_UPSTREAM_KEY: 'inline-no-permitido',
  }, 'production');
  assert.ok(errors.some((error) => error.includes('PORTAL_PUBLIC_URL debe usar HTTPS')));
  assert.ok(errors.some((error) => error.includes('API_PUBLIC_URL debe contener solo el origen')));
  assert.ok(errors.some((error) => error.includes('POSTGRES_PASSWORD no debe definirse')));
  assert.ok(errors.some((error) => error.includes('SECRETS_DIR debe ser una ruta absoluta')));
  assert.ok(errors.some((error) => error.includes('INGEST_SHARED_KEY no debe definirse')));
  assert.ok(errors.some((error) => error.includes('HOLMES_UPSTREAM_KEY no debe definirse')));
});

test('configuracion productiva válida no genera errores', () => {
  assert.deepEqual(validateConfiguration({
    BIND_ADDR: '127.0.0.1',
    SECRETS_DIR: '/etc/ekumetrics/secrets',
    AGENT_TLS_DIR: '/etc/ekumetrics/agent-tls',
    AGENT_EDGE_BIND_ADDR: '0.0.0.0',
    AGENT_PUBLIC_HOST: 'ingest.acme.test',
    PORTAL_PUBLIC_URL: 'https://monitoring.acme.test',
    API_PUBLIC_URL: 'https://api.acme.test',
    GRAFANA_PUBLIC_URL: 'https://grafana.acme.test',
    KEYCLOAK_PUBLIC_URL: 'https://auth.acme.test',
    KEYCLOAK_ADMIN_USERNAME: 'platform-admin',
  }, 'production'), []);
});

test('produccion exige separar aplicaciones por hostname', () => {
  const errors = validateConfiguration({
    BIND_ADDR: '127.0.0.1',
    SECRETS_DIR: '/etc/ekumetrics/secrets',
    AGENT_TLS_DIR: '/etc/ekumetrics/agent-tls',
    AGENT_EDGE_BIND_ADDR: '0.0.0.0',
    AGENT_PUBLIC_HOST: 'ingest.acme.test',
    PORTAL_PUBLIC_URL: 'https://monitoring.acme.test',
    API_PUBLIC_URL: 'https://monitoring.acme.test',
    GRAFANA_PUBLIC_URL: 'https://grafana.acme.test',
    KEYCLOAK_PUBLIC_URL: 'https://auth.acme.test',
    KEYCLOAK_ADMIN_USERNAME: 'platform-admin',
  }, 'production');
  assert.ok(errors.some((error) => error.includes('hostnames distintos')));
});

test('valida presencia, longitud y permisos de secretos montados', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ekumetrics-secrets-'));
  const names = [
    'postgres_password', 'database_url', 'keycloak_db_password',
    'keycloak_admin_password', 'grafana_admin_password', 'ingest_shared_key',
    'agent_edge_assertion_key', 'kiosk_token_secret', 'bff_session_secret',
    'ai_settings_encryption_key', 'holmes_upstream_key',
  ];
  try {
    for (const name of names) {
      const value = name === 'database_url'
        ? 'postgresql://user:password@postgres:5432/ekumetrics'
        : '0123456789abcdef0123456789abcdef';
      const path = join(directory, name);
      writeFileSync(path, value, { mode: 0o400 });
      chmodSync(path, 0o400);
    }
    assert.deepEqual(validateSecretDirectory(directory), []);
    chmodSync(join(directory, 'ingest_shared_key'), 0o600);
    writeFileSync(join(directory, 'ingest_shared_key'), 'short');
    chmodSync(join(directory, 'ingest_shared_key'), 0o644);
    const errors = validateSecretDirectory(directory);
    assert.ok(errors.some((error) => error.includes('32 caracteres')));
    assert.ok(errors.some((error) => error.includes('acceso de otros usuarios')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('el realm productivo exige enrolamiento TOTP de 30 segundos', () => {
  const realm = JSON.parse(readFileSync('infrastructure/docker/keycloak/ekumetrics-production-realm.json', 'utf8'));
  const totp = realm.requiredActions.find((action) => action.alias === 'CONFIGURE_TOTP');
  assert.equal(totp?.enabled, true);
  assert.equal(totp?.defaultAction, true);
  assert.equal(realm.otpPolicyType, 'totp');
  assert.equal(realm.otpPolicyAlgorithm, 'HmacSHA256');
  assert.equal(realm.otpPolicyDigits, 6);
  assert.equal(realm.otpPolicyPeriod, 30);
});
