import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRollbackPath, assertRollbackState, assertUpgradePath, parseUpgradeArgs,
} from './upgrade.mjs';

const matrix = {
  releases: {
    '1.0.0': { upgradeFrom: [], rollbackTo: null, schemaBackwardCompatible: true },
    '1.0.1': { upgradeFrom: ['1.0.0'], rollbackTo: '1.0.0', schemaBackwardCompatible: true },
    '2.0.0': { upgradeFrom: ['1.0.1'], rollbackTo: '1.0.1', schemaBackwardCompatible: false },
  },
};

test('acepta únicamente rutas de upgrade declaradas', () => {
  assert.equal(assertUpgradePath(matrix, '1.0.0', '1.0.1').rollbackTo, '1.0.0');
  assert.throws(() => assertUpgradePath(matrix, '1.0.0', '2.0.0'), /no está soportada/);
});

test('rollback exige esquema backward-compatible', () => {
  assert.equal(assertRollbackPath(matrix, '1.0.1', '1.0.0').rollbackTo, '1.0.0');
  assert.throws(() => assertRollbackPath(matrix, '2.0.0', '1.0.1'), /backward-compatible/);
});

test('backup cifrado es obligatorio para upgrade', () => {
  const original = process.env.EKUMETRICS_BACKUP_RECIPIENT;
  delete process.env.EKUMETRICS_BACKUP_RECIPIENT;
  assert.throws(() => parseUpgradeArgs([]), /backup/);
  if (original) process.env.EKUMETRICS_BACKUP_RECIPIENT = original;
});

test('rollback acepta solo evidencia completa e imágenes inmutables', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const state = {
    schemaVersion: 1,
    status: 'succeeded',
    fromVersion: '1.0.0',
    toVersion: '1.0.1',
    previousImages: {
      api: { tag: 'ekumetrics-platform-api:1.0.0', digest },
      portal: { tag: 'ekumetrics-portal-web:1.0.0', digest },
    },
  };
  assert.equal(assertRollbackState(state), state);
  assert.throws(() => assertRollbackState({ ...state, status: 'prepared' }), /completado/);
  assert.throws(() => assertRollbackState({
    ...state,
    previousImages: { ...state.previousImages, api: { tag: 'evil:latest', digest } },
  }), /imagen api/);
});
