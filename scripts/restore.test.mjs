import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRestoreArgs, validateArchiveEntries, validateManifest } from './restore.mjs';

test('restore exige confirmación destructiva exacta', () => {
  assert.throws(() => parseRestoreArgs([
    '--backup', 'backup.tar.age', '--identity', 'identity.txt',
  ]), /RESTORE-EKUMETRICS/);
});

test('restore rechaza path traversal y archivos inesperados', () => {
  assert.throws(
    () => validateArchiveEntries(['manifest.json', 'platform.dump', '../secret']),
    /no permitida/,
  );
});

test('manifiesto productivo requiere ambas bases', () => {
  assert.throws(() => validateManifest({
    schemaVersion: 1,
    product: 'ekumetrics-platform',
    mode: 'production',
    databases: [{ file: 'platform.dump' }],
  }, 'production'), /keycloak.dump/);
});

test('acepta un manifiesto productivo compatible', () => {
  assert.equal(validateManifest({
    schemaVersion: 1,
    product: 'ekumetrics-platform',
    mode: 'production',
    databases: [{ file: 'platform.dump' }, { file: 'keycloak.dump' }],
  }, 'production'), true);
});
