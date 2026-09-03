#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { composeArgs } from './backup.mjs';

const ALLOWED_ARCHIVE_FILES = new Set(['manifest.json', 'platform.dump', 'keycloak.dump']);

export function parseRestoreArgs(argv) {
  const options = {
    mode: 'production',
    env: 'infrastructure/docker/.env.production',
    evidence: 'restore-evidence',
    timeout: 600,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') options.mode = argv[++index];
    else if (arg === '--env') options.env = argv[++index];
    else if (arg === '--backup') options.backup = argv[++index];
    else if (arg === '--identity') options.identity = argv[++index];
    else if (arg === '--evidence') options.evidence = argv[++index];
    else if (arg === '--timeout') options.timeout = Number(argv[++index]);
    else if (arg === '--confirm') options.confirm = argv[++index];
    else if (arg === '--help') options.help = true;
    else throw new Error(`Opción desconocida: ${arg}`);
  }
  if (options.help) return options;
  if (!['local', 'production'].includes(options.mode)) throw new Error('--mode debe ser local o production.');
  if (!options.backup || !options.backup.endsWith('.tar.age')) throw new Error('Indique --backup con un archivo .tar.age.');
  if (!options.identity) throw new Error('Indique --identity con la identidad privada age.');
  if (options.confirm !== 'RESTORE-EKUMETRICS') {
    throw new Error('La restauración reemplaza datos. Confirme con --confirm RESTORE-EKUMETRICS.');
  }
  if (!Number.isInteger(options.timeout) || options.timeout < 60 || options.timeout > 3600) {
    throw new Error('--timeout debe estar entre 60 y 3600 segundos.');
  }
  return options;
}

export function validateArchiveEntries(entries) {
  const normalized = entries.filter(Boolean).map((entry) => entry.replace(/^\.\//, ''));
  if (!normalized.includes('manifest.json') || !normalized.includes('platform.dump')) {
    throw new Error('El archivo no contiene manifest.json y platform.dump.');
  }
  for (const entry of normalized) {
    if (!ALLOWED_ARCHIVE_FILES.has(entry)) throw new Error(`Entrada no permitida en el backup: ${entry}`);
  }
  return normalized;
}

export function validateManifest(manifest, mode) {
  if (manifest.schemaVersion !== 1 || manifest.product !== 'ekumetrics-platform') {
    throw new Error('Manifiesto incompatible con Ekumetrics Platform.');
  }
  if (manifest.mode !== mode) throw new Error(`El backup es ${manifest.mode}, pero se solicitó ${mode}.`);
  const files = new Set(manifest.databases?.map((database) => database.file));
  if (!files.has('platform.dump')) throw new Error('El manifiesto no contiene platform.dump.');
  if (mode === 'production' && !files.has('keycloak.dump')) {
    throw new Error('El backup productivo no contiene keycloak.dump.');
  }
  return true;
}

function run(command, args, quiet = false) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = quiet ? (result.stderr || result.stdout).trim() : '';
    throw new Error(`${command} terminó con código ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return quiet ? result.stdout.trim() : '';
}

function pipeFileToCommand(path, command, args) {
  return new Promise((resolvePromise, reject) => {
    const input = createReadStream(path);
    const child = spawn(command, args, { stdio: ['pipe', 'inherit', 'pipe'] });
    let stderr = '';
    input.pipe(child.stdin);
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 16_384) stderr += chunk.toString();
    });
    input.once('error', reject);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} terminó con código ${code}: ${stderr.trim()}`));
    });
  });
}

function sha256(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function usage() {
  console.log(`Uso: node scripts/restore.mjs [opciones]\n\n  --backup ARCHIVO          Backup .tar.age\n  --identity ARCHIVO        Identidad privada age\n  --mode local|production   Perfil (production por defecto)\n  --env RUTA                Archivo de entorno\n  --evidence DIRECTORIO     Evidencia del simulacro\n  --timeout SEGUNDOS        Espera de healthchecks (600 por defecto)\n  --confirm RESTORE-EKUMETRICS\n                            Confirmación destructiva obligatoria\n  --help                    Mostrar esta ayuda`);
}

async function main() {
  const options = parseRestoreArgs(process.argv.slice(2));
  if (options.help) return usage();
  const startedAt = new Date();
  const backupPath = resolve(options.backup);
  const identityPath = resolve(options.identity);
  statSync(backupPath);
  statSync(identityPath);
  readFileSync(options.env, 'utf8');
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'ekumetrics-restore-'));
  const archivePath = join(temporaryDirectory, 'backup.tar');
  const dockerArgs = composeArgs(options);

  console.log('Ekumetrics restore · operación destructiva confirmada');
  try {
    console.log('1/6 Descifrando backup...');
    run('age', ['--decrypt', '--identity', identityPath, '--output', archivePath, backupPath], true);
    const entries = validateArchiveEntries(run('tar', ['-tf', archivePath], true).split(/\r?\n/));
    run('tar', ['-C', temporaryDirectory, '-xf', archivePath, ...entries], true);

    console.log('2/6 Verificando manifiesto y checksums...');
    const manifest = JSON.parse(readFileSync(join(temporaryDirectory, 'manifest.json'), 'utf8'));
    validateManifest(manifest, options.mode);
    for (const database of manifest.databases) {
      const path = join(temporaryDirectory, database.file);
      if (!ALLOWED_ARCHIVE_FILES.has(database.file) || await sha256(path) !== database.sha256) {
        throw new Error(`Checksum inválido para ${database.file}.`);
      }
    }

    console.log('3/6 Deteniendo consumidores de datos...');
    run('docker', [...dockerArgs, 'stop', 'platform-api', 'ingest-gateway', 'keycloak']);
    run('docker', [...dockerArgs, 'up', '-d', '--wait', '--wait-timeout', String(options.timeout), 'postgres', ...(options.mode === 'production' ? ['keycloak-db'] : [])]);

    console.log('4/6 Restaurando PostgreSQL de la plataforma...');
    await pipeFileToCommand(join(temporaryDirectory, 'platform.dump'), 'docker', [
      ...dockerArgs, 'exec', '-T', 'postgres', 'pg_restore',
      '--username=ekumetrics', '--dbname=ekumetrics', '--clean', '--if-exists',
      '--no-owner', '--no-privileges', '--exit-on-error',
    ]);
    if (options.mode === 'production') {
      console.log('5/6 Restaurando PostgreSQL de Keycloak...');
      await pipeFileToCommand(join(temporaryDirectory, 'keycloak.dump'), 'docker', [
        ...dockerArgs, 'exec', '-T', 'keycloak-db', 'pg_restore',
        '--username=keycloak', '--dbname=keycloak', '--clean', '--if-exists',
        '--no-owner', '--no-privileges', '--exit-on-error',
      ]);
    } else {
      console.log('5/6 Keycloak local se reconstruirá desde el realm versionado.');
    }

    console.log('6/6 Levantando y verificando la plataforma...');
    run('docker', [...dockerArgs, 'up', '-d', '--wait', '--wait-timeout', String(options.timeout)]);
    const completedAt = new Date();
    const evidenceDirectory = resolve(options.evidence);
    mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
    const evidence = {
      schemaVersion: 1,
      productVersion: manifest.productVersion,
      backup: basename(backupPath),
      backupCreatedAt: manifest.createdAt,
      restoreStartedAt: startedAt.toISOString(),
      restoreCompletedAt: completedAt.toISOString(),
      durationSeconds: Math.round((completedAt - startedAt) / 1000),
      estimatedDataLossSeconds: Math.max(0, Math.round((startedAt - new Date(manifest.createdAt)) / 1000)),
      mode: options.mode,
      result: 'succeeded',
    };
    const evidencePath = join(evidenceDirectory, `restore-${completedAt.toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(`\n✓ Restauración completada. Evidencia: ${evidencePath}`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\n✗ Restauración fallida: ${error.message}`);
    console.error('La plataforma puede estar detenida o parcialmente restaurada. No reintente sin revisar los logs y el runbook.');
    process.exitCode = 1;
  });
}
