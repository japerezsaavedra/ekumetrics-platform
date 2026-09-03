import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateZapReport } from './zap-report-check.mjs';

const accepted = {
  schemaVersion: 1,
  acceptedAlerts: [
    {
      pluginId: '10055',
      name: 'CSP: style-src unsafe-inline',
      owner: 'Security',
      ticket: 'EKM-10',
      expiresAt: '2026-12-31',
      rationale: 'Migración a nonces planificada.',
    },
  ],
};

function policy(...entries) {
  return { schemaVersion: 1, acceptedAlerts: entries };
}

function report(alerts) {
  return { site: [{ alerts }] };
}

test('acepta únicamente el hallazgo exacto y vigente', () => {
  const result = evaluateZapReport(
    report([{ pluginid: '10055', name: 'CSP: style-src unsafe-inline', riskcode: '2' }]),
    accepted,
    new Date('2026-08-27T00:00:00Z'),
  );
  assert.deepEqual(result.errors, []);
});

test('bloquea un riesgo medio no registrado', () => {
  const result = evaluateZapReport(
    report([
      { pluginid: '10055', name: 'CSP: style-src unsafe-inline', riskcode: '2' },
      { pluginid: '40018', name: 'SQL Injection', riskcode: '3', riskdesc: 'High' },
    ]),
    accepted,
    new Date('2026-08-27T00:00:00Z'),
  );
  assert.ok(result.errors.some((error) => error.includes('SQL Injection')));
});

test('bloquea también un riesgo bajo no registrado', () => {
  const result = evaluateZapReport(
    report([{ pluginid: '10110', name: 'Dangerous JS Functions', riskcode: '1' }]),
    policy(),
    new Date('2026-08-27T00:00:00Z'),
  );
  assert.ok(result.errors.some((error) => error.includes('Dangerous JS Functions')));
});

test('bloquea excepciones vencidas o que ya no aparecen', () => {
  const expired = evaluateZapReport(
    report([{ pluginid: '10055', name: 'CSP: style-src unsafe-inline', riskcode: '2' }]),
    accepted,
    new Date('2027-01-01T00:00:00Z'),
  );
  assert.ok(expired.errors.some((error) => error.includes('venció')));

  const stale = evaluateZapReport(report([]), accepted, new Date('2026-08-27T00:00:00Z'));
  assert.ok(stale.errors.some((error) => error.includes('ya no apareció')));
});
