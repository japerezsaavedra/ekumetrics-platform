import assert from 'node:assert/strict';
import test from 'node:test';
import { composeArgs, parseInstallArgs, readinessUrls } from './install.mjs';

test('construye el compose productivo con ambos archivos', () => {
  const options = parseInstallArgs([
    '--mode',
    'production',
    '--env',
    'prod.env',
    '--timeout',
    '900',
  ]);
  assert.deepEqual(composeArgs(options), [
    'compose',
    '--env-file',
    'prod.env',
    '-f',
    'infrastructure/docker/docker-compose.yml',
    '-f',
    'infrastructure/docker/docker-compose.production.yml',
  ]);
  assert.equal(options.timeout, 900);
});

test('rechaza un timeout inseguro', () => {
  assert.throws(() => parseInstallArgs(['--timeout', '10']), /entre 60 y 3600/);
});

test('normaliza el binding público para comprobar endpoints locales', () => {
  const urls = readinessUrls({ BIND_ADDR: '0.0.0.0' }, 'local');
  assert.equal(urls[0].url, 'http://127.0.0.1:3000/health/ready');
  assert.ok(urls.some((target) => target.url.includes(':8080/realms/ekumetrics')));
  assert.ok(urls.some((target) => target.url === 'http://127.0.0.1:3200/ready'));
});

test('producción no intenta acceder al listener mTLS sin certificado', () => {
  const urls = readinessUrls({
    BIND_ADDR: '127.0.0.1',
    PORTAL_PUBLIC_URL: 'https://monitoring.acme.test',
    KEYCLOAK_PUBLIC_URL: 'https://auth.acme.test',
  }, 'production');
  assert.ok(!urls.some((target) => target.url.includes(':4318')));
  assert.ok(urls.some((target) => target.name === 'Portal público'));
});
