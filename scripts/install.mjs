#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseEnv } from './preflight.mjs';

export function parseInstallArgs(argv) {
  const options = {
    mode: 'local',
    env: 'infrastructure/docker/.env',
    timeout: 600,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') options.mode = argv[++index];
    else if (arg === '--env') options.env = argv[++index];
    else if (arg === '--timeout') options.timeout = Number(argv[++index]);
    else if (arg === '--help') options.help = true;
    else throw new Error(`Opción desconocida: ${arg}`);
  }
  if (!['local', 'production'].includes(options.mode)) {
    throw new Error('--mode debe ser local o production.');
  }
  if (!Number.isInteger(options.timeout) || options.timeout < 60 || options.timeout > 3600) {
    throw new Error('--timeout debe estar entre 60 y 3600 segundos.');
  }
  return options;
}

export function composeArgs(options) {
  const args = [
    'compose',
    '--env-file',
    options.env,
    '-f',
    'infrastructure/docker/docker-compose.yml',
  ];
  if (options.mode === 'production') {
    args.push('-f', 'infrastructure/docker/docker-compose.production.yml');
  }
  return args;
}

export function readinessUrls(config, mode) {
  const bindAddress = ['0.0.0.0', '::'].includes(config.BIND_ADDR)
    ? '127.0.0.1'
    : config.BIND_ADDR || '127.0.0.1';
  const urls = [
    { name: 'API', url: `http://${bindAddress}:3000/health/ready` },
  ];
  if (mode === 'production') {
    urls.push(
      { name: 'Portal público', url: config.PORTAL_PUBLIC_URL },
      {
        name: 'OIDC',
        url: `${config.KEYCLOAK_PUBLIC_URL.replace(/\/$/, '')}/realms/ekumetrics/.well-known/openid-configuration`,
      },
    );
  } else {
    urls.push(
      { name: 'Gateway de ingesta', url: `http://${bindAddress}:4318/healthz` },
      { name: 'Tempo', url: `http://${bindAddress}:3200/ready` },
      { name: 'Portal', url: `http://${bindAddress}:4200` },
      {
        name: 'OIDC',
        url: `http://${bindAddress}:8080/realms/ekumetrics/.well-known/openid-configuration`,
      },
    );
  }
  return urls;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? (result.stderr || result.stdout).trim() : '';
    throw new Error(`${command} terminó con código ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return options.capture ? result.stdout.trim() : '';
}

async function assertReady(target) {
  const response = await fetch(target.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${target.name} respondió HTTP ${response.status}.`);
  console.log(`✓ ${target.name}: ${target.url}`);
}

function usage() {
  console.log(`Uso: node scripts/install.mjs [opciones]\n\n  --mode local|production   Perfil a instalar (local por defecto)\n  --env RUTA                Archivo de entorno\n  --timeout SEGUNDOS        Espera de healthchecks, 60-3600 (600 por defecto)\n  --help                    Mostrar esta ayuda`);
}

async function main() {
  const options = parseInstallArgs(process.argv.slice(2));
  if (options.help) return usage();
  const config = parseEnv(readFileSync(options.env, 'utf8'));
  const dockerArgs = composeArgs(options);

  console.log(`Ekumetrics installer · perfil ${options.mode}`);
  console.log('\n[1/4] Validando el host y la configuración...');
  run(process.execPath, [
    'scripts/preflight.mjs',
    '--mode',
    options.mode,
    '--env',
    options.env,
  ]);

  console.log('\n[2/4] Construyendo y levantando servicios...');
  run('docker', [
    ...dockerArgs,
    'up',
    '-d',
    '--build',
    '--wait',
    '--wait-timeout',
    String(options.timeout),
  ]);

  console.log('\n[3/4] Verificando endpoints...');
  for (const target of readinessUrls(config, options.mode)) {
    await assertReady(target);
  }
  const probeService = options.mode === 'production' ? 'agent-edge' : 'ingest-gateway';
  run('docker', [
    ...dockerArgs,
    'exec',
    '-T',
    probeService,
    'wget',
    '-qO-',
    'http://otel-collector:13133',
  ], { capture: true });
  console.log(`✓ Collector accesible desde ${probeService}.`);
  run('docker', [
    ...dockerArgs,
    'exec',
    '-T',
    probeService,
    'wget',
    '-qO-',
    'http://tempo:3200/ready',
  ], { capture: true });
  console.log(`✓ Tempo accesible desde ${probeService}.`);

  console.log('\n[4/4] Estado final...');
  const status = run('docker', [...dockerArgs, 'ps', '--format', 'table {{.Service}}\t{{.Status}}'], { capture: true });
  console.log(status);
  console.log('\n✓ Ekumetrics quedó instalado y listo.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\n✗ Instalación incompleta: ${error.message}`);
    console.error('Los contenedores y volúmenes se conservaron para diagnóstico. Revise `npm run platform:logs`.');
    process.exitCode = 1;
  });
}
