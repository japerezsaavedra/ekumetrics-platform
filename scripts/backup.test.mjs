import assert from 'node:assert/strict';
import test from 'node:test';
import { composeArgs, expiredBackups, parseBackupArgs } from './backup.mjs';

test('backup productivo incluye el override y retención configurada', () => {
  const options = parseBackupArgs(['--recipient', 'age1publicrecipient', '--retention-days', '90']);
  assert.equal(options.retentionDays, 90);
  assert.ok(composeArgs(options).includes('infrastructure/docker/docker-compose.production.yml'));
});

test('backup exige destinatario de cifrado', () => {
  const original = process.env.EKUMETRICS_BACKUP_RECIPIENT;
  delete process.env.EKUMETRICS_BACKUP_RECIPIENT;
  assert.throws(() => parseBackupArgs([]), /destinatario age/);
  if (original) process.env.EKUMETRICS_BACKUP_RECIPIENT = original;
});

test('retención solo selecciona backups vencidos del producto', () => {
  const now = Date.parse('2026-08-26T12:00:00Z');
  const entries = [
    { name: 'ekumetrics-backup-old.tar.age', mtimeMs: now - 31 * 86_400_000 },
    { name: 'ekumetrics-backup-new.tar.age', mtimeMs: now - 2 * 86_400_000 },
    { name: 'otro.tar.age', mtimeMs: now - 100 * 86_400_000 },
  ];
  assert.deepEqual(expiredBackups(entries, now, 30).map((entry) => entry.name), [
    'ekumetrics-backup-old.tar.age',
  ]);
});
