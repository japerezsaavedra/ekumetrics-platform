#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { readFileSync, statSync, statfsSync } from 'node:fs';
import { createServer, isIP } from 'node:net';
import { cpus, freemem, platform, totalmem } from 'node:os';
import { resolve4, resolve6 } from 'node:dns/promises';
import { connect as tlsConnect } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { isAbsolute, join } from 'node:path';

const DEFAULT_PORTS = [3000, 3001, 3100, 4222, 4317, 4318, 5050, 5432, 8080, 8222, 9091, 9093, 11434];
const PRODUCTION_SECRET_FILES = [
  'postgres_password',
  'database_url',
  'keycloak_db_password',
  'keycloak_admin_password',
  'grafana_admin_password',
  'ingest_shared_key',
  'agent_edge_assertion_key',
  'kiosk_token_secret',
  'bff_session_secret',
  'ai_settings_encryption_key',
  'holmes_upstream_key',
];
const LONG_SECRET_FILES = new Set([
  'ingest_shared_key',
  'agent_edge_assertion_key',
  'kiosk_token_secret',
  'bff_session_secret',
  'ai_settings_encryption_key',
  'holmes_upstream_key',
]);
const INLINE_PRODUCTION_SECRETS = [
  'POSTGRES_PASSWORD',
  'DATABASE_URL',
  'KEYCLOAK_DB_PASSWORD',
  'KEYCLOAK_ADMIN_PASSWORD',
  'GRAFANA_ADMIN_PASSWORD',
  'INGEST_SHARED_KEY',
  'AGENT_EDGE_ASSERTION_KEY',
  'KIOSK_TOKEN_SECRET',
  'BFF_SESSION_SECRET',
  'AI_SETTINGS_ENCRYPTION_KEY',
  'HOLMES_UPSTREAM_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'MOONSHOT_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'AI_COMPAT_API_KEY',
];

export function parseEnv(source) {
  const result = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export function validateConfiguration(config, mode) {
  const errors = [];
  const required = mode === 'production'
    ? ['BIND_ADDR', 'PORTAL_PUBLIC_URL', 'API_PUBLIC_URL', 'GRAFANA_PUBLIC_URL', 'KEYCLOAK_PUBLIC_URL', 'KEYCLOAK_ADMIN_USERNAME', 'SECRETS_DIR', 'AGENT_TLS_DIR', 'AGENT_EDGE_BIND_ADDR', 'AGENT_PUBLIC_HOST']
    : ['BIND_ADDR', 'PUBLIC_HOST', 'POSTGRES_PASSWORD', 'KEYCLOAK_ADMIN_PASSWORD', 'GRAFANA_ADMIN_PASSWORD', 'INGEST_SHARED_KEY', 'KIOSK_TOKEN_SECRET', 'BFF_SESSION_SECRET', 'AI_SETTINGS_ENCRYPTION_KEY'];

  for (const key of required) {
    const value = config[key]?.trim();
    if (!value) errors.push(`Falta ${key} en el archivo de entorno.`);
    if (/change-me|example\.com/i.test(value ?? '')) errors.push(`${key} conserva un valor de ejemplo.`);
  }
  for (const key of ['INGEST_SHARED_KEY', 'KIOSK_TOKEN_SECRET', 'BFF_SESSION_SECRET', 'AI_SETTINGS_ENCRYPTION_KEY']) {
    if (mode === 'production') continue;
    if ((config[key] ?? '').length < 32) errors.push(`${key} debe contener al menos 32 caracteres aleatorios.`);
  }
  for (const key of ['POSTGRES_PASSWORD', 'KEYCLOAK_ADMIN_PASSWORD', 'GRAFANA_ADMIN_PASSWORD']) {
    if (mode === 'production') continue;
    if ((config[key] ?? '').length < 16) errors.push(`${key} debe contener al menos 16 caracteres.`);
  }
  if (mode === 'production') {
    if (config.SECRETS_DIR && !isAbsolute(config.SECRETS_DIR)) {
      errors.push('SECRETS_DIR debe ser una ruta absoluta.');
    }
    if (config.AGENT_TLS_DIR && !isAbsolute(config.AGENT_TLS_DIR)) {
      errors.push('AGENT_TLS_DIR debe ser una ruta absoluta.');
    }
    for (const key of INLINE_PRODUCTION_SECRETS) {
      if (config[key]) errors.push(`${key} no debe definirse directamente en producción; use SECRETS_DIR.`);
    }
    const publicUrlKeys = ['PORTAL_PUBLIC_URL', 'API_PUBLIC_URL', 'GRAFANA_PUBLIC_URL', 'KEYCLOAK_PUBLIC_URL'];
    const publicHosts = [];
    for (const key of publicUrlKeys) {
      try {
        const url = new URL(config[key]);
        publicHosts.push(url.hostname.toLowerCase());
        if (url.protocol !== 'https:') errors.push(`${key} debe usar HTTPS.`);
        if (url.pathname !== '/' || url.search || url.hash) {
          errors.push(`${key} debe contener solo el origen, sin ruta, query ni fragmento.`);
        }
      } catch {
        errors.push(`${key} no es una URL válida.`);
      }
    }
    if (publicHosts.length === publicUrlKeys.length && new Set(publicHosts).size !== publicHosts.length) {
      errors.push('Portal, API, Grafana y Keycloak deben publicarse en hostnames distintos.');
    }
  }
  return [...new Set(errors)];
}

export function validateSecretDirectory(directory) {
  const errors = [];
  for (const name of PRODUCTION_SECRET_FILES) {
    const path = join(directory, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) errors.push(`${name} no es un archivo regular.`);
      if ((stat.mode & 0o027) !== 0) errors.push(`${name} permite escritura de grupo o acceso de otros usuarios.`);
      const value = readFileSync(path, 'utf8').trim();
      if (!value) errors.push(`${name} está vacío.`);
      if (/\r|\n/.test(value)) errors.push(`${name} contiene múltiples líneas.`);
      const minimumLength = LONG_SECRET_FILES.has(name) ? 32 : 16;
      if (name !== 'database_url' && value.length < minimumLength) errors.push(`${name} debe contener al menos ${minimumLength} caracteres.`);
      if (name === 'database_url') {
        try {
          const url = new URL(value);
          if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password || !url.hostname || !url.pathname.slice(1)) {
            errors.push('database_url debe ser un DSN PostgreSQL completo con usuario, contraseña, host y base de datos.');
          }
        } catch {
          errors.push('database_url no es un DSN PostgreSQL válido.');
        }
      }
    } catch {
      errors.push(`No se puede leer el secreto ${name} en SECRETS_DIR.`);
    }
  }
  return errors;
}

export function validateTlsDirectory(directory, publicHost) {
  const errors = [];
  const paths = {
    ca: join(directory, 'ca.crt'),
    certificate: join(directory, 'server.crt'),
    key: join(directory, 'server.key'),
  };
  try {
    for (const [name, path] of Object.entries(paths)) {
      const stat = statSync(path);
      if (!stat.isFile()) errors.push(`${name} TLS no es un archivo regular.`);
      if (name === 'key' && (stat.mode & 0o037) !== 0) {
        errors.push('server.key permite acceso excesivo; use 0400 o 0440.');
      }
      if (!readFileSync(path).length) errors.push(`${name} TLS está vacío.`);
    }
    if (errors.length) return errors;

    const ca = new X509Certificate(readFileSync(paths.ca));
    const certificate = new X509Certificate(readFileSync(paths.certificate));
    const privateKey = createPrivateKey(readFileSync(paths.key));
    const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
    const privatePublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    if (!certificatePublicKey.equals(privatePublicKey)) errors.push('server.key no corresponde a server.crt.');
    if (!ca.ca || !certificate.verify(ca.publicKey)) errors.push('server.crt no fue emitido por ca.crt.');
    const expiresInDays = Math.floor((Date.parse(certificate.validTo) - Date.now()) / 86_400_000);
    if (!Number.isFinite(expiresInDays) || expiresInDays < 30) errors.push('server.crt vence en menos de 30 días o su fecha no es válida.');
    const hostMatch = isIP(publicHost)
      ? certificate.checkIP(publicHost)
      : certificate.checkHost(publicHost);
    if (!hostMatch) errors.push(`server.crt no cubre AGENT_PUBLIC_HOST (${publicHost}).`);
  } catch (error) {
    errors.push(`No se puede validar AGENT_TLS_DIR: ${error.message}`);
  }
  return errors;
}

function parseArgs(argv) {
  const options = { mode: 'local', env: 'infrastructure/docker/.env', skipPorts: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') options.mode = argv[++index];
    else if (arg === '--env') options.env = argv[++index];
    else if (arg === '--skip-port-check') options.skipPorts = true;
    else if (arg === '--help') options.help = true;
    else throw new Error(`Opción desconocida: ${arg}`);
  }
  if (!['local', 'production'].includes(options.mode)) throw new Error('--mode debe ser local o production.');
  return options;
}

function command(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function checkPort(host, port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', (error) => resolve({ ok: false, detail: `${host}:${port} no está disponible (${error.code ?? error.message}).` }));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve({ ok: true })));
  });
}

async function resolveHost(host) {
  const addresses = await Promise.allSettled([resolve4(host), resolve6(host)]);
  return addresses.flatMap((entry) => entry.status === 'fulfilled' ? entry.value : []);
}

function checkTls(urlValue) {
  const url = new URL(urlValue);
  return new Promise((resolve) => {
    const socket = tlsConnect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname, rejectUnauthorized: true, timeout: 8_000 }, () => {
      const certificate = socket.getPeerCertificate();
      const expiresAt = Date.parse(certificate.valid_to);
      const remainingDays = Math.floor((expiresAt - Date.now()) / 86_400_000);
      socket.end();
      if (!Number.isFinite(expiresAt)) resolve({ ok: false, detail: `${url.hostname}: no fue posible leer el vencimiento del certificado.` });
      else if (remainingDays < 30) resolve({ ok: false, detail: `${url.hostname}: el certificado vence en ${remainingDays} días.` });
      else resolve({ ok: true, detail: `${url.hostname}: certificado válido por ${remainingDays} días.` });
    });
    socket.once('timeout', () => socket.destroy(new Error('timeout')));
    socket.once('error', (error) => resolve({ ok: false, detail: `${url.hostname}: TLS no válido o inaccesible (${error.message}).` }));
  });
}

function checkClock() {
  try {
    if (platform() === 'linux') {
      const synchronized = command('timedatectl', ['show', '--property=NTPSynchronized', '--value']);
      return synchronized === 'yes' ? { ok: true, detail: 'Reloj sincronizado por NTP.' } : { ok: false, detail: 'NTP no está sincronizado; revise timedatectl.' };
    }
    if (platform() === 'darwin') {
      const output = command('systemsetup', ['-getusingnetworktime']);
      if (/on$/i.test(output)) return { ok: true, detail: 'Hora de red habilitada.' };
      if (/off$/i.test(output)) return { ok: false, detail: 'Active la hora de red en macOS.' };
      return { ok: false, warning: true, detail: 'No se pudo verificar NTP sin privilegios; confirme la hora de red de macOS.' };
    }
  } catch {
    return { ok: false, warning: true, detail: 'No se pudo verificar NTP sin privilegios; confirme la sincronización del reloj del host.' };
  }
  return { ok: false, warning: true, detail: 'Sistema no reconocido; confirme manualmente la sincronización NTP.' };
}

function usage() {
  console.log(`Uso: node scripts/preflight.mjs [opciones]\n\n  --mode local|production   Perfil a validar (local por defecto)\n  --env RUTA                Archivo de entorno\n  --skip-port-check         Solo para validar una instalación ya iniciada\n  --help                    Mostrar esta ayuda`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const failures = [];
  const warnings = [];
  const pass = (message) => console.log(`✓ ${message}`);
  const fail = (message) => { failures.push(message); console.error(`✗ ${message}`); };
  const warn = (message) => { warnings.push(message); console.warn(`! ${message}`); };

  console.log(`Ekumetrics preflight · perfil ${options.mode}`);
  let config;
  try {
    config = parseEnv(readFileSync(options.env, 'utf8'));
    pass(`Archivo de entorno legible: ${options.env}`);
  } catch (error) {
    fail(`No se puede leer ${options.env}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  for (const error of validateConfiguration(config, options.mode)) fail(error);
  if (options.mode === 'production' && config.SECRETS_DIR) {
    for (const error of validateSecretDirectory(config.SECRETS_DIR)) fail(error);
  }
  if (options.mode === 'production' && config.AGENT_TLS_DIR && config.AGENT_PUBLIC_HOST) {
    for (const error of validateTlsDirectory(config.AGENT_TLS_DIR, config.AGENT_PUBLIC_HOST)) fail(error);
  }
  if (failures.length === 0) pass('Configuración obligatoria y secretos sin valores de ejemplo.');

  const minimumCpu = Number(process.env.EKUMETRICS_MIN_CPU ?? 4);
  const minimumRamGiB = Number(process.env.EKUMETRICS_MIN_RAM_GIB ?? 8);
  const minimumDiskGiB = Number(process.env.EKUMETRICS_MIN_DISK_GIB ?? 20);
  const cpuCount = cpus().length;
  const ramGiB = totalmem() / 2 ** 30;
  const freeRamGiB = freemem() / 2 ** 30;
  const disk = statfsSync(process.cwd());
  const diskGiB = Number(disk.bavail) * Number(disk.bsize) / 2 ** 30;
  cpuCount >= minimumCpu ? pass(`CPU: ${cpuCount} cores (mínimo ${minimumCpu}).`) : fail(`CPU insuficiente: ${cpuCount} cores; se requieren ${minimumCpu}.`);
  ramGiB >= minimumRamGiB ? pass(`RAM: ${ramGiB.toFixed(1)} GiB total, ${freeRamGiB.toFixed(1)} GiB libre.`) : fail(`RAM insuficiente: ${ramGiB.toFixed(1)} GiB; se requieren ${minimumRamGiB} GiB.`);
  diskGiB >= minimumDiskGiB ? pass(`Disco libre: ${diskGiB.toFixed(1)} GiB.`) : fail(`Disco insuficiente: ${diskGiB.toFixed(1)} GiB libres; se requieren ${minimumDiskGiB} GiB.`);

  try {
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    nodeMajor === 24 ? pass(`Node.js ${process.versions.node}.`) : fail(`Node.js ${process.versions.node}; se requiere la versión 24 LTS.`);
    const npmVersion = command('npm', ['--version']);
    Number(npmVersion.split('.')[0]) === 12 ? pass(`npm ${npmVersion}.`) : fail(`npm ${npmVersion}; se requiere la versión 12.`);
    pass(`Docker ${command('docker', ['version', '--format', '{{.Server.Version}}'])}.`);
    pass(`Docker Compose ${command('docker', ['compose', 'version', '--short'])}.`);
  } catch (error) {
    fail(`Toolchain incompleto o Docker no está operativo (${error.message}).`);
  }

  try {
    const composeArgs = ['compose', '--env-file', options.env, '-f', 'infrastructure/docker/docker-compose.yml'];
    if (options.mode === 'production') composeArgs.push('-f', 'infrastructure/docker/docker-compose.production.yml');
    composeArgs.push('config', '--quiet');
    command('docker', composeArgs);
    pass('Docker Compose acepta la configuración.');
  } catch (error) {
    fail(`Docker Compose rechazó la configuración (${error.message}).`);
  }

  if (options.skipPorts) warn('Comprobación de puertos omitida explícitamente.');
  else {
    const host = config.BIND_ADDR || '127.0.0.1';
    const portResults = await Promise.all(DEFAULT_PORTS.map(async (port) => ({ port, ...(await checkPort(host, port)) })));
    for (const result of portResults) result.ok ? pass(`Puerto ${host}:${result.port} disponible.`) : fail(`${result.detail} Detenga el proceso que lo ocupa o cambie el binding.`);
  }

  const clock = checkClock();
  clock.ok ? pass(clock.detail) : clock.warning && options.mode === 'local' ? warn(clock.detail) : fail(clock.detail);

  if (options.mode === 'production') {
    const urls = [
      config.PORTAL_PUBLIC_URL,
      config.API_PUBLIC_URL,
      config.GRAFANA_PUBLIC_URL,
      config.KEYCLOAK_PUBLIC_URL,
    ];
    for (const value of urls) {
      let url;
      try {
        url = new URL(value);
        const addresses = await resolveHost(url.hostname);
        addresses.length ? pass(`DNS ${url.hostname}: ${addresses.join(', ')}.`) : fail(`DNS ${url.hostname} no devuelve direcciones.`);
      } catch (error) {
        fail(`No se pudo resolver ${value} (${error.message}).`);
        continue;
      }
      const tls = await checkTls(url.href);
      tls.ok ? pass(tls.detail) : fail(tls.detail);
    }
  } else {
    pass('DNS y certificados externos no aplican al perfil local.');
  }

  console.log(`\nResultado: ${failures.length} error(es), ${warnings.length} advertencia(s).`);
  if (failures.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`✗ Preflight interrumpido: ${error.message}`);
    process.exitCode = 1;
  });
}
