import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDiagnosticArgs, redact, sensitiveFindings } from './diagnostics.mjs';

test('redacta credenciales, JWT, correos, IP y rutas personales', () => {
  const source = 'email=admin@acme.test password=hunter2 Bearer eyJabc.def.ghi host=10.10.0.2 path=/Users/jperez/project';
  const output = redact(source);
  assert.equal(sensitiveFindings(output).length, 0);
  assert.ok(output.includes('[REDACTED_EMAIL]'));
  assert.ok(output.includes('[REDACTED_TOKEN]'));
  assert.ok(output.includes('[REDACTED_IP]'));
  assert.ok(output.includes('/Users/[REDACTED_USER]/project'));
  assert.ok(!output.includes('hunter2'));
});

test('conserva loopback para que el diagnóstico sea accionable', () => {
  assert.equal(redact('127.0.0.1 0.0.0.0'), '127.0.0.1 0.0.0.0');
});

test('no permite empaquetar sin revisión explícita', () => {
  assert.throws(
    () => parseDiagnosticArgs(['--pack', 'ekumetrics-diagnostics-test']),
    /REVIEWED/,
  );
});

test('el escáner residual bloquea credenciales y claves privadas', () => {
  assert.ok(sensitiveFindings('password=hunter2').includes('credential assignment'));
  assert.ok(
    sensitiveFindings('-----BEGIN PRIVATE KEY-----').includes('private key'),
  );
});
