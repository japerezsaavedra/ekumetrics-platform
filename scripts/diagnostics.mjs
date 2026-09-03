#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, statfsSync,
  writeFileSync,
} from 'node:fs';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTAINERS = [
  'ekumetrics-postgres', 'ekumetrics-nats', 'ekumetrics-prometheus',
  'ekumetrics-node-exporter', 'ekumetrics-loki', 'ekumetrics-tempo', 'ekumetrics-alertmanager',
  'ekumetrics-grafana', 'ekumetrics-otel', 'ekumetrics-keycloak',
  'ekumetrics-api', 'ekumetrics-ingest-gateway', 'ekumetrics-portal',
  'ekumetrics-agent-edge',
];

export function redact(input) {
  return String(input)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:sk|xai|ghp|gho|github_pat)-[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED_API_KEY]')
    .replace(/AGE-SECRET-KEY-[A-Z0-9-]+/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[REDACTED]@')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\/(?:Users|home)\/[^/\s]+/g, (value) =>
      value.startsWith('/Users/') ? '/Users/[REDACTED_USER]' : '/home/[REDACTED_USER]',
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (value) =>
      value === '127.0.0.1' || value === '0.0.0.0' ? value : '[REDACTED_IP]',
    )
    .replace(
      /((?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|displayName|username|actor|tenant)(?:\s*[=:]\s*|"\s*:\s*"))([^\s,"'}]+)/gi,
      '$1[REDACTED]',
    );
}

export function sensitiveFindings(input) {
  const value = String(input);
  const checks = [
    ['JWT', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/],
    ['Bearer token', /\bBearer\s+(?!\[REDACTED_TOKEN\])[A-Za-z0-9._~+/=-]+/i],
    ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ['private age key', /AGE-SECRET-KEY-[A-Z0-9-]+/],
    ['API key', /\b(?:sk|xai|ghp|gho|github_pat)-[A-Za-z0-9_-]{12,}\b/i],
    ['home path', /\/(?:Users|home)\/(?!\[REDACTED_USER\])[^/\s]+/],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['credential assignment', /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)\s*[=:]\s*(?!\[REDACTED)[^\s,}]+/i],
  ];
  return checks.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
}

export function parseDiagnosticArgs(argv) {
  const options = { output: 'diagnostics', since: '30m', tail: 500 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') options.output = argv[++index];
    else if (arg === '--since') options.since = argv[++index];
    else if (arg === '--tail') options.tail = Number(argv[++index]);
    else if (arg === '--pack') options.pack = argv[++index];
    else if (arg === '--confirm') options.confirm = argv[++index];
    else if (arg === '--help') options.help = true;
    else throw new Error(`Opción desconocida: ${arg}`);
  }
  if (!Number.isInteger(options.tail) || options.tail < 10 || options.tail > 10_000) {
    throw new Error('--tail debe estar entre 10 y 10000.');
  }
  if (!/^\d+[smhd]$/.test(options.since)) throw new Error('--since debe usar formato como 30m, 2h o 1d.');
  if (options.pack && options.confirm !== 'REVIEWED') {
    throw new Error('Revise el directorio y confirme el empaquetado con --confirm REVIEWED.');
  }
  return options;
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 25 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return `ERROR: ${result.error.message}`;
  return `${result.stdout ?? ''}${result.stderr ? `\nSTDERR:\n${result.stderr}` : ''}\nEXIT_CODE=${result.status ?? 1}`;
}

function safeWrite(directory, name, content) {
  const sanitized = redact(content).slice(0, 5 * 1024 * 1024);
  const findings = sensitiveFindings(sanitized);
  if (findings.length) throw new Error(`${name} conserva datos sensibles: ${findings.join(', ')}.`);
  const target = join(directory, name);
  writeFileSync(target, sanitized.endsWith('\n') ? sanitized : `${sanitized}\n`, { mode: 0o600 });
  return target;
}

async function health(url) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return { url, status: response.status, ok: response.ok, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { url, ok: false, latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
  }
}

function filesRecursively(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`No se permiten symlinks: ${relative}`);
    if (entry.isDirectory()) files.push(...filesRecursively(directory, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function pack(directory) {
  const absolute = resolve(directory);
  if (!basename(absolute).startsWith('ekumetrics-diagnostics-')) {
    throw new Error('Solo se empaquetan directorios ekumetrics-diagnostics-* generados por esta herramienta.');
  }
  const files = filesRecursively(absolute);
  for (const file of files) {
    const findings = sensitiveFindings(readFileSync(join(absolute, file), 'utf8'));
    if (findings.length) throw new Error(`${file} contiene ${findings.join(', ')}.`);
  }
  const archive = `${absolute}.tar.gz`;
  const result = spawnSync('tar', ['-C', resolve(absolute, '..'), '-czf', archive, basename(absolute)], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`tar terminó con código ${result.status}.`);
  chmodSync(archive, 0o600);
  console.log(`✓ Paquete listo para compartir: ${archive}`);
}

function usage() {
  console.log(`Uso:\n  node scripts/diagnostics.mjs [--output DIR] [--since 30m] [--tail 500]\n  node scripts/diagnostics.mjs --pack DIRECTORIO --confirm REVIEWED\n\nLa recolección nunca empaqueta automáticamente. Revise cada archivo antes de confirmar.`);
}

async function main() {
  const options = parseDiagnosticArgs(process.argv.slice(2));
  if (options.help) return usage();
  if (options.pack) return pack(options.pack);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = resolve(options.output, `ekumetrics-diagnostics-${timestamp}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const disk = statfsSync(process.cwd());
  const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
  const apiPackage = JSON.parse(readFileSync('apps/platform-api/package.json', 'utf8'));
  const portalPackage = JSON.parse(readFileSync('apps/portal-web/package.json', 'utf8'));

  safeWrite(directory, 'versions.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    productVersion: rootPackage.version,
    apiVersion: apiPackage.version,
    portalVersion: portalPackage.version,
    node: process.versions.node,
    platform: platform(),
    osRelease: release(),
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    freeDiskBytes: Number(disk.bavail) * Number(disk.bsize),
  }, null, 2));
  safeWrite(directory, 'docker-version.txt', capture('docker', ['version']));
  safeWrite(directory, 'container-status.txt', capture('docker', [
    'ps', '--all', '--filter', 'label=com.docker.compose.project=ekumetrics',
    '--format', 'table {{.Names}}\t{{.Image}}\t{{.Status}}',
  ]));
  safeWrite(directory, 'compose-template.txt', capture('docker', [
    'compose', '-f', 'infrastructure/docker/docker-compose.yml',
    '-f', 'infrastructure/docker/docker-compose.production.yml',
    'config', '--no-interpolate',
  ]));

  const healthResults = await Promise.all([
    health('http://127.0.0.1:3000/health'),
    health('http://127.0.0.1:3000/health/ready'),
    health('http://127.0.0.1:4318/healthz'),
    health('http://127.0.0.1:9091/-/ready'),
    health('http://127.0.0.1:3100/ready'),
    health('http://127.0.0.1:3200/ready'),
  ]);
  safeWrite(directory, 'health.json', JSON.stringify(healthResults, null, 2));

  mkdirSync(join(directory, 'logs'), { mode: 0o700 });
  for (const container of CONTAINERS) {
    safeWrite(join(directory, 'logs'), `${container}.log`, capture('docker', [
      'logs', '--since', options.since, '--tail', String(options.tail), container,
    ]));
  }

  safeWrite(directory, 'REVIEW-BEFORE-SHARING.md', `# Revisar antes de compartir\n\nEste directorio fue redactado automáticamente, pero debe revisarlo una persona autorizada.\n\n- Abra todos los archivos, especialmente \`logs/\` y \`compose-template.txt\`.\n- Confirme que no haya payloads, nombres, correos, IP, tokens, claves ni datos del cliente.\n- Elimine cualquier archivo que no sea necesario para el caso de soporte.\n- Para empaquetar después de revisar: \`node scripts/diagnostics.mjs --pack /ruta/al/directorio --confirm REVIEWED\`.\n- Comparta únicamente por el canal privado acordado.\n`);

  const manifestFiles = filesRecursively(directory).map((file) => ({
    file,
    bytes: lstatSync(join(directory, file)).size,
    sha256: createHash('sha256').update(readFileSync(join(directory, file))).digest('hex'),
  }));
  safeWrite(directory, 'manifest.json', JSON.stringify({ schemaVersion: 1, files: manifestFiles }, null, 2));
  console.log(`✓ Diagnóstico redactado: ${directory}`);
  console.log('Revise el contenido. No se creó un archivo compartible automáticamente.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`✗ Diagnóstico fallido: ${error.message}`);
    process.exitCode = 1;
  });
}
