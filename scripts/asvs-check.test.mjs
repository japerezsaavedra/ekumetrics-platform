import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAsvsTracker } from './asvs-check.mjs';

function tracker() {
  const controls = Array.from({ length: 253 }, (_, index) => ({
    id: `V${index + 1}`,
    chapterId: 'V1',
    sectionId: 'V1.1',
    level: index < 70 ? 1 : 2,
    requirement: 'Control verificable',
    status: 'not-reviewed',
    owner: null,
    evidence: [],
    ticket: 'EKM-10',
    reviewedAt: null,
    rationale: null,
  }));
  return {
    schemaVersion: 1,
    standard: {
      version: '5.0.0',
      targetLevel: 2,
      sourceSha256: '8201b20eec2908c3380ac600c91c8ba746346fbb808859366abb232027532311',
    },
    controls,
  };
}

test('valida los 253 controles heredados por ASVS L2', () => {
  assert.deepEqual(validateAsvsTracker(tracker()), { 'not-reviewed': 253 });
});

test('un control verificado exige evidencia y revisión', () => {
  const value = tracker();
  value.controls[0].status = 'verified';
  assert.throws(() => validateAsvsTracker(value), /evidencia/);
});

test('la compuerta de release rechaza controles sin resolver', () => {
  assert.throws(() => validateAsvsTracker(tracker(), { assertReady: true }), /impide declarar/);
});
