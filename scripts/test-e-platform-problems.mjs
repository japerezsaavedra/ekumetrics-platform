#!/usr/bin/env node
/**
 * Prueba reversible de problemas para E-Platform.
 * No modifica codigo de producto. Pausa Tempo, compara /v1/platform/overview y lo reanuda.
 */
import { execSync } from 'node:child_process';

const API = process.env.API_BASE_URL || 'http://127.0.0.1:3000';
const ORIGIN = process.env.PORTAL_ORIGIN || 'http://127.0.0.1:4200';
const EMAIL = process.env.EKU_OPERATOR_EMAIL || 'operator@gradotech.com';
const PASSWORD = process.env.EKU_OPERATOR_PASSWORD || 'ekumetrics-local';
const TEMPO = 'ekumetrics-tempo';
const WAIT_MS = Number(process.env.EKU_PROBLEM_WAIT_MS || 35_000);

const jar = new Map();

function setCookies(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const item of raw) {
    const [pair] = item.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function call(method, path, body, extra = {}) {
  const headers = {
    Origin: ORIGIN,
    Accept: 'application/json',
    ...extra,
  };
  if (jar.size) headers.Cookie = cookieHeader();
  let data;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    data = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: data });
  setCookies(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 240)}`);
  }
  return json;
}

function docker(cmd) {
  return execSync(`docker ${cmd}`, { encoding: 'utf8' }).trim();
}

function tempoPaused() {
  const status = docker(`inspect -f '{{.State.Status}} {{.State.Paused}}' ${TEMPO}`);
  return status.includes('true');
}

function snapshotServices(overview) {
  return (overview.services ?? []).map((item) => ({
    label: item.label,
    job: item.job,
    up: item.up,
  }));
}

function summarize(overview) {
  return {
    services: snapshotServices(overview),
    slo: overview.slo,
    saturation: overview.slo?.saturation,
    api: {
      rps: overview.api?.requestsPerSec,
      errors: overview.api?.errorRatio,
      p95: overview.api?.p95Seconds,
    },
    traces: overview.traces?.length ?? 0,
  };
}

function diffServices(before, after) {
  const map = new Map(before.map((item) => [item.job, item]));
  return after
    .filter((item) => map.get(item.job)?.up !== item.up)
    .map((item) => ({
      label: item.label,
      job: item.job,
      before: map.get(item.job)?.up ? 'Activo' : 'Sin senal',
      after: item.up ? 'Activo' : 'Sin senal',
    }));
}

async function login() {
  const session = await call('POST', '/v1/auth/login', { email: EMAIL, password: PASSWORD });
  const csrf = session.csrfToken;
  if (!csrf) throw new Error('Login sin csrfToken');
  return csrf;
}

async function overview(csrf) {
  return call('GET', '/v1/platform/overview', undefined, { 'X-CSRF-Token': csrf });
}

async function loadBurst(csrf) {
  await Promise.all(
    Array.from({ length: 20 }, () =>
      call('GET', '/v1/platform/overview', undefined, { 'X-CSRF-Token': csrf }).catch(() => null),
    ),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('E-Platform problem test');
  console.log(`API ${API}`);
  const csrf = await login();
  const before = summarize(await overview(csrf));
  console.log('antes');
  console.log(JSON.stringify(before, null, 2));

  console.log(`pausa ${TEMPO} ${WAIT_MS}ms`);
  docker(`pause ${TEMPO}`);
  try {
    await loadBurst(csrf);
    await sleep(WAIT_MS);
    const during = summarize(await overview(csrf));
    const changed = diffServices(before.services, during.services);
    console.log('durante');
    console.log(JSON.stringify({ ...during, changed }, null, 2));
    if (!changed.some((item) => item.job === 'tempo' && item.after === 'Sin senal')) {
      console.log('aviso: Tempo aun no aparece como Sin senal; Prometheus scrapea cada 15s.');
    }
  } finally {
    if (tempoPaused()) {
      docker(`unpause ${TEMPO}`);
      console.log(`reanudado ${TEMPO}`);
    }
  }

  await sleep(20_000);
  const after = summarize(await overview(csrf));
  console.log('despues');
  console.log(JSON.stringify(after, null, 2));
  const recovered = after.services.find((item) => item.job === 'tempo')?.up === true;
  console.log(recovered ? 'Tempo volvio a Activo.' : 'Tempo sigue sin senal; recargue E-Platform en 15s.');
}

main().catch((err) => {
  try {
    if (tempoPaused()) docker(`unpause ${TEMPO}`);
  } catch {
    /* restore best-effort */
  }
  console.error(String(err?.message ?? err));
  process.exit(1);
});
