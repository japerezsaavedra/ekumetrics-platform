#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EXPECTED = { total: 253, level1: 70, level2: 183 };
const STATUSES = new Set(['not-reviewed', 'verified', 'not-applicable', 'open']);

function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function reviewed(control) {
  return present(control.owner)
    && present(control.reviewedAt)
    && !Number.isNaN(Date.parse(control.reviewedAt));
}

export function validateAsvsTracker(tracker, { assertReady = false } = {}) {
  const errors = [];
  if (tracker?.schemaVersion !== 1) errors.push('schemaVersion debe ser 1.');
  if (tracker?.standard?.version !== '5.0.0' || tracker?.standard?.targetLevel !== 2) {
    errors.push('El registro debe fijar OWASP ASVS 5.0.0 nivel 2.');
  }
  if (tracker?.standard?.sourceSha256 !== '8201b20eec2908c3380ac600c91c8ba746346fbb808859366abb232027532311') {
    errors.push('El SHA-256 de la fuente ASVS estable no coincide.');
  }
  const controls = Array.isArray(tracker?.controls) ? tracker.controls : [];
  if (controls.length !== EXPECTED.total) errors.push(`Se esperaban ${EXPECTED.total} controles; hay ${controls.length}.`);
  const ids = new Set();
  const levelCounts = { 1: 0, 2: 0 };
  for (const [index, control] of controls.entries()) {
    const label = present(control?.id) ? control.id : `índice ${index}`;
    if (!present(control?.id) || ids.has(control.id)) errors.push(`${label}: ID ausente o duplicado.`);
    ids.add(control?.id);
    if (![1, 2].includes(control?.level)) errors.push(`${label}: nivel fuera del alcance L2.`);
    else levelCounts[control.level] += 1;
    if (!present(control?.chapterId) || !present(control?.sectionId) || !present(control?.requirement)) {
      errors.push(`${label}: metadatos normativos incompletos.`);
    }
    if (!STATUSES.has(control?.status)) errors.push(`${label}: estado inválido.`);
    if (control?.status === 'verified' && (!reviewed(control) || !control.evidence?.some(present))) {
      errors.push(`${label}: verificado exige responsable, fecha y evidencia.`);
    }
    if (control?.status === 'not-applicable' && (!reviewed(control) || !present(control.rationale))) {
      errors.push(`${label}: no aplicable exige responsable, fecha y justificación.`);
    }
    if (control?.status === 'open' && (!present(control.owner) || !/^EKM-\d+$/.test(control.ticket ?? ''))) {
      errors.push(`${label}: abierto exige responsable e incidencia EKM-n.`);
    }
    if (assertReady && !['verified', 'not-applicable'].includes(control?.status)) {
      errors.push(`${label}: impide declarar ASVS L2 listo.`);
    }
  }
  if (levelCounts[1] !== EXPECTED.level1 || levelCounts[2] !== EXPECTED.level2) {
    errors.push(`Distribución incorrecta: L1=${levelCounts[1]}, L2=${levelCounts[2]}.`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return controls.reduce((summary, control) => {
    summary[control.status] = (summary[control.status] ?? 0) + 1;
    return summary;
  }, {});
}

function main() {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf('--file');
  const file = fileIndex >= 0 ? args[fileIndex + 1] : 'security/asvs/controls.json';
  if (!file) throw new Error('--file exige una ruta.');
  const summary = validateAsvsTracker(JSON.parse(readFileSync(file, 'utf8')), {
    assertReady: args.includes('--assert-ready'),
  });
  console.log(`✓ ASVS 5.0.0 L2: 253 controles íntegros. ${JSON.stringify(summary)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`✗ Registro ASVS inválido:\n${error.message}`);
    process.exitCode = 1;
  }
}
