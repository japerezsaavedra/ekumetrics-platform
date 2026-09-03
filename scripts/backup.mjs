#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream, createWriteStream, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseBackupArgs(argv) {
  const options = {
    mode: 'production', env: 'infrastructure/docker/.env.production',
    output: 'backups', retentionDays: 30,
    recipient: process.env.EKUMETRICS_BACKUP_RECIPIENT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') options.mode = argv[++index];
    else if (arg === '--env') options.env = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--retention-days') options.retentionDays = Number(argv[++index]);
    else if (arg === '--recipient') options.recipient = argv[++index];
    else if (arg === '--help') options.help = true;
    else throw new Error(`Opción desconocida: ${arg}`);
  }
  if (!['local', 'production'].includes(options.mode)) throw new Error('--mode debe ser local o production.');
  if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1 || options.retentionDays > 3650) {
    throw new Error('--retention-days debe estar entre 1 y 3650.');
  }
  if (!options.recipient && !options.help) {
    throw new Error('Defina --recipient o EKUMETRICS_BACKUP_RECIPIENT con un destinatario age público.');
  }
  return options;
}

export function composeArgs(options) {
  const args = ['compose', '--env-file', options.env, '-f', 'infrastructure/docker/docker-compose.yml'];
  if (options.mode === 'production') args.push('-f', 'infrastructure/docker/docker-compose.production.yml');
  return args;
}

export function expiredBackups(entries, nowMs, retentionDays) {
  const cutoff = nowMs - retentionDays * 86_400_000;
  return entries.filter((entry) =>
    /^ekumetrics-backup-.*\.tar\.age$/.test(entry.name) && entry.mtimeMs < cutoff,
  );
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

function dumpToFile(command, args, target) {
  return new Promise((resolvePromise, reject) => {
    const output = createWriteStream(target, { flags: 'wx', mode: 0o600 });
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let childDone = false;
    let outputDone = false;
    let settled = false;
    const finish = () => {
      if (!settled && childDone && outputDone) {
        settled = true;
        resolvePromise();
      }
    };
    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    child.stdout.pipe(output);
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 16_384) stderr += chunk.toString();
    });
    output.once('error', fail);
    output.once('close', () => {
      outputDone = true;
      finish();
    });
    child.once('error', fail);
    child.once('close', (code) => {
      if (code !== 0) fail(new Error(`${command} terminó con código ${code}: ${stderr.trim()}`));
      else {
        childDone = true;
        finish();
      }
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
  console.log(`Uso: node scripts/backup.mjs [opciones]\n\n  --mode local|production   Perfil (production por defecto)\n  --env RUTA                Archivo de entorno\n  --output DIRECTORIO       Destino local (backups por defecto)\n  --recipient AGE           Destinatario age público\n  --retention-days DÍAS     Retención local, 1-3650 (30 por defecto)\n  --help                    Mostrar esta ayuda\n\nEl directorio de salida debe sincronizarse después con almacenamiento externo versionado.`);
}

async function main() {
  const options = parseBackupArgs(process.argv.slice(2));
  if (options.help) return usage();
  readFileSync(options.env, 'utf8');
  run('age', ['--version'], true);
  run('docker', ['version', '--format', '{{.Server.Version}}'], true);

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const outputDirectory = resolve(options.output);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'ekumetrics-backup-'));
  const archive = join(temporaryDirectory, `ekumetrics-backup-${stamp}.tar`);
  const encrypted = join(outputDirectory, `${basename(archive)}.age`);
  const dockerArgs = composeArgs(options);

  console.log(`Ekumetrics backup · perfil ${options.mode}`);
  try {
    const files = [];
    const platformDump = join(temporaryDirectory, 'platform.dump');
    console.log('1/4 Respaldando PostgreSQL de la plataforma...');
    await dumpToFile('docker', [
      ...dockerArgs, 'exec', '-T', 'postgres', 'pg_dump',
      '--username=ekumetrics', '--dbname=ekumetrics', '--format=custom',
      '--no-owner', '--no-privileges',
    ], platformDump);
    files.push(platformDump);

    if (options.mode === 'production') {
      const keycloakDump = join(temporaryDirectory, 'keycloak.dump');
      console.log('2/4 Respaldando PostgreSQL de Keycloak...');
      await dumpToFile('docker', [
        ...dockerArgs, 'exec', '-T', 'keycloak-db', 'pg_dump',
        '--username=keycloak', '--dbname=keycloak', '--format=custom',
        '--no-owner', '--no-privileges',
      ], keycloakDump);
      files.push(keycloakDump);
    } else {
      console.log('2/4 Keycloak local se reconstruye desde el realm versionado.');
    }

    const manifest = {
      schemaVersion: 1, product: 'ekumetrics-platform', productVersion: '1.0.0',
      mode: options.mode, createdAt: startedAt.toISOString(), host: process.platform,
      databases: [],
    };
    for (const file of files) {
      manifest.databases.push({
        file: basename(file), bytes: statSync(file).size, sha256: await sha256(file),
      });
    }
    writeFileSync(join(temporaryDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    console.log('3/4 Empaquetando y cifrando...');
    run('tar', ['-C', temporaryDirectory, '-cf', archive, 'manifest.json', ...files.map((file) => basename(file))], true);
    run('age', ['--recipient', options.recipient, '--output', encrypted, archive], true);

    console.log('4/4 Aplicando retención local...');
    const entries = readdirSync(outputDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, mtimeMs: statSync(join(outputDirectory, entry.name)).mtimeMs }));
    for (const entry of expiredBackups(entries, Date.now(), options.retentionDays)) {
      const target = join(outputDirectory, entry.name);
      if (target !== encrypted) unlinkSync(target);
    }

    console.log(`\n✓ Backup cifrado creado: ${encrypted}`);
    console.log(`  Tamaño: ${(statSync(encrypted).size / 2 ** 20).toFixed(1)} MiB`);
    console.log('  Siguiente paso obligatorio: copiarlo a almacenamiento externo inmutable/versionado.');
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\n✗ Backup fallido: ${error.message}`);
    process.exitCode = 1;
  });
}
