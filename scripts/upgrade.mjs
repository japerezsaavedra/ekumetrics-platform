#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseUpgradeArgs(argv) {
  const options = {
    mode: 'production',
    env: 'infrastructure/docker/.env.production',
    backupOutput: 'backups',
    stateOutput: 'release-state',
    timeout: 600,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') options.mode = argv[++index];
    else if (arg === '--env') options.env = argv[++index];
    else if (arg === '--from') options.from = argv[++index];
    else if (arg === '--recipient') options.recipient = argv[++index];
    else if (arg === '--backup-output') options.backupOutput = argv[++index];
    else if (arg === '--state-output') options.stateOutput = argv[++index];
    else if (arg === '--timeout') options.timeout = Number(argv[++index]);
    else if (arg === '--rollback') options.rollback = argv[++index];
    else if (arg === '--confirm') options.confirm = argv[++index];
    else if (arg === '--help') options.help = true;
    else throw new Error(`Opción desconocida: ${arg}`);
  }
  if (options.help) return options;
  if (!['local', 'production'].includes(options.mode)) throw new Error('--mode debe ser local o production.');
  if (!Number.isInteger(options.timeout) || options.timeout < 60 || options.timeout > 3600) {
    throw new Error('--timeout debe estar entre 60 y 3600 segundos.');
  }
  if (options.rollback && options.confirm !== 'ROLLBACK-EKUMETRICS') {
    throw new Error('Confirme el rollback con --confirm ROLLBACK-EKUMETRICS.');
  }
  if (!options.rollback && !options.recipient && !process.env.EKUMETRICS_BACKUP_RECIPIENT) {
    throw new Error('La actualización exige --recipient o EKUMETRICS_BACKUP_RECIPIENT para el backup.');
  }
  return options;
}

export function assertUpgradePath(matrix, fromVersion, toVersion) {
  const target = matrix.releases?.[toVersion];
  if (!target) throw new Error(`La release ${toVersion} no existe en la matriz.`);
  if (!target.upgradeFrom?.includes(fromVersion)) {
    throw new Error(`La actualización ${fromVersion} → ${toVersion} no está soportada.`);
  }
  return target;
}

export function assertRollbackPath(matrix, fromVersion, toVersion) {
  const current = matrix.releases?.[fromVersion];
  if (!current || current.rollbackTo !== toVersion) {
    throw new Error(`El rollback ${fromVersion} → ${toVersion} no está soportado.`);
  }
  if (!current.schemaBackwardCompatible) {
    throw new Error('El esquema no es backward-compatible; use restauración autorizada de base de datos.');
  }
  return current;
}

export function assertRollbackState(state) {
  const versionPattern = /^\d+\.\d+\.\d+$/;
  if (state?.schemaVersion !== 1 || state.status !== 'succeeded') {
    throw new Error('La evidencia no corresponde a un upgrade completado.');
  }
  if (!versionPattern.test(state.fromVersion ?? '') || !versionPattern.test(state.toVersion ?? '')) {
    throw new Error('La evidencia contiene versiones inválidas.');
  }
  for (const service of ['api', 'portal']) {
    const image = state.previousImages?.[service];
    const expectedTag = service === 'api'
      ? `ekumetrics-platform-api:${state.fromVersion}`
      : `ekumetrics-portal-web:${state.fromVersion}`;
    if (image?.tag !== expectedTag || !/^sha256:[a-f0-9]{64}$/.test(image.digest ?? '')) {
      throw new Error(`La evidencia de imagen ${service} es inválida.`);
    }
  }
  return state;
}

function composeArgs(options) {
  const args = ['compose', '--env-file', options.env, '-f', 'infrastructure/docker/docker-compose.yml'];
  if (options.mode === 'production') args.push('-f', 'infrastructure/docker/docker-compose.production.yml');
  return args;
}

function run(command, args, { capture = false, env } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: env ?? process.env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 25 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout).trim() : '';
    throw new Error(`${command} terminó con código ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return capture ? result.stdout.trim() : '';
}

async function installedVersion(fromOverride) {
  if (fromOverride) return fromOverride;
  try {
    const response = await fetch('http://127.0.0.1:3000/health/ready', {
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json();
    if (response.ok && typeof body.version === 'string') return body.version;
  } catch {
    // El mensaje siguiente explica cómo continuar sin asumir una versión.
  }
  throw new Error('No se pudo determinar la versión instalada; indique --from explícitamente.');
}

function newestBackup(directory, startedAt) {
  const root = resolve(directory);
  const matches = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tar.age'))
    .map((entry) => ({ path: join(root, entry.name), mtimeMs: statSync(join(root, entry.name)).mtimeMs }))
    .filter((entry) => entry.mtimeMs >= startedAt)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!matches[0]) throw new Error('El backup terminó sin producir un archivo cifrado nuevo.');
  return matches[0].path;
}

function imageDigest(image) {
  return run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { capture: true });
}

function writeState(directory, state) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `upgrade-${state.startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function verifyVersion(expected) {
  const response = await fetch('http://127.0.0.1:3000/health/ready', {
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (!response.ok || body.version !== expected) {
    throw new Error(`La API respondió versión ${body.version ?? 'desconocida'}; se esperaba ${expected}.`);
  }
}

async function upgrade(options, matrix, targetVersion) {
  const fromVersion = await installedVersion(options.from);
  if (fromVersion === targetVersion) throw new Error(`La versión ${targetVersion} ya está instalada.`);
  const target = assertUpgradePath(matrix, fromVersion, targetVersion);
  const dockerArgs = composeArgs(options);
  const targetEnv = { ...process.env, EKUMETRICS_VERSION: targetVersion };
  const startedAt = new Date().toISOString();

  console.log(`Ekumetrics upgrade ${fromVersion} → ${targetVersion}`);
  console.log('1/7 Verificando contrato de release...');
  run(process.execPath, ['scripts/release-check.mjs']);
  console.log('2/7 Ejecutando preflight sobre la instalación activa...');
  run(process.execPath, ['scripts/preflight.mjs', '--mode', options.mode, '--env', options.env, '--skip-port-check']);
  console.log('3/7 Generando backup cifrado obligatorio...');
  const backupStartedAt = Date.now();
  run(process.execPath, [
    'scripts/backup.mjs', '--mode', options.mode, '--env', options.env,
    '--output', options.backupOutput, '--recipient', options.recipient ?? process.env.EKUMETRICS_BACKUP_RECIPIENT,
  ]);
  const backup = newestBackup(options.backupOutput, backupStartedAt);
  const state = {
    schemaVersion: 1,
    status: 'prepared',
    startedAt,
    fromVersion,
    toVersion: targetVersion,
    databaseMigration: target.databaseMigration,
    schemaBackwardCompatible: target.schemaBackwardCompatible,
    backup: basename(backup),
    previousImages: {
      api: { tag: `ekumetrics-platform-api:${fromVersion}`, digest: imageDigest(`ekumetrics-platform-api:${fromVersion}`) },
      portal: { tag: `ekumetrics-portal-web:${fromVersion}`, digest: imageDigest(`ekumetrics-portal-web:${fromVersion}`) },
    },
  };
  const statePath = writeState(options.stateOutput, state);
  console.log('4/7 Construyendo imágenes destino inmutables...');
  run('docker', [...dockerArgs, 'build', '--pull', 'platform-api', 'portal-web'], { env: targetEnv });
  console.log('5/7 Desplegando y aplicando migraciones...');
  run('docker', [...dockerArgs, 'up', '-d', '--no-build', '--wait', '--wait-timeout', String(options.timeout)], { env: targetEnv });
  console.log('6/7 Verificando versión y readiness...');
  await verifyVersion(targetVersion);
  console.log('7/7 Registrando evidencia...');
  state.status = 'succeeded';
  state.completedAt = new Date().toISOString();
  state.targetImages = {
    api: { tag: `ekumetrics-platform-api:${targetVersion}`, digest: imageDigest(`ekumetrics-platform-api:${targetVersion}`) },
    portal: { tag: `ekumetrics-portal-web:${targetVersion}`, digest: imageDigest(`ekumetrics-portal-web:${targetVersion}`) },
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  console.log(`✓ Upgrade completado. Evidencia y rollback: ${statePath}`);
}

async function rollback(options, matrix) {
  const statePath = resolve(options.rollback);
  const state = assertRollbackState(JSON.parse(readFileSync(statePath, 'utf8')));
  assertRollbackPath(matrix, state.toVersion, state.fromVersion);
  for (const service of ['api', 'portal']) {
    const retainedDigest = imageDigest(state.previousImages[service].tag);
    if (retainedDigest !== state.previousImages[service].digest) {
      throw new Error(`La imagen retenida ${service} no coincide con el digest registrado; rollback cancelado.`);
    }
  }
  const dockerArgs = composeArgs(options);
  const previousEnv = { ...process.env, EKUMETRICS_VERSION: state.fromVersion };
  console.log(`Ekumetrics rollback ${state.toVersion} → ${state.fromVersion}`);
  run('docker', [...dockerArgs, 'up', '-d', '--no-build', '--wait', '--wait-timeout', String(options.timeout)], { env: previousEnv });
  await verifyVersion(state.fromVersion);
  const evidence = {
    ...state,
    rollbackCompletedAt: new Date().toISOString(),
    rollbackResult: 'succeeded',
  };
  writeFileSync(statePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`✓ Rollback completado sin revertir el esquema aditivo: ${statePath}`);
}

function usage() {
  console.log(`Uso:\n  node scripts/upgrade.mjs --recipient AGE [--from VERSION] [opciones]\n  node scripts/upgrade.mjs --rollback ESTADO.json --confirm ROLLBACK-EKUMETRICS [opciones]\n\nLa versión destino siempre es la versión declarada por el checkout actual.`);
}

async function main() {
  const options = parseUpgradeArgs(process.argv.slice(2));
  if (options.help) return usage();
  const matrix = JSON.parse(readFileSync('release/compatibility.json', 'utf8'));
  const targetVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
  if (options.rollback) await rollback(options, matrix);
  else await upgrade(options, matrix, targetVersion);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`✗ Operación de release fallida: ${error.message}`);
    process.exitCode = 1;
  });
}
