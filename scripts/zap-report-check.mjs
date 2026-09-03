#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function alertKey(alert) {
  return `${alert.pluginid ?? alert.pluginId}:${alert.name}`;
}

export function evaluateZapReport(report, policy, now = new Date()) {
  const errors = [];
  const warnings = [];
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy?.acceptedAlerts)) {
    return { errors: ['La política DAST no tiene el esquema esperado.'], warnings };
  }

  const accepted = new Map();
  for (const entry of policy.acceptedAlerts) {
    const key = `${entry.pluginId}:${entry.name}`;
    if (
      !entry.pluginId ||
      !entry.name ||
      !entry.owner ||
      !/^EKM-\d+$/.test(entry.ticket ?? '') ||
      !entry.rationale ||
      Number.isNaN(Date.parse(entry.expiresAt ?? ''))
    ) {
      errors.push(`${key}: excepción incompleta o sin incidencia/vencimiento válido.`);
      continue;
    }
    if (Date.parse(`${entry.expiresAt}T23:59:59Z`) < now.getTime()) {
      errors.push(`${key}: la aceptación de riesgo venció el ${entry.expiresAt}.`);
    }
    accepted.set(key, entry);
  }

  const alerts = (report?.site ?? []).flatMap((site) => site.alerts ?? []);
  const observedAccepted = new Set();
  for (const alert of alerts) {
    const risk = Number(alert.riskcode ?? -1);
    const key = alertKey(alert);
    if (accepted.has(key)) {
      observedAccepted.add(key);
      warnings.push(`${key}: riesgo aceptado temporalmente (${alert.riskdesc}).`);
    } else if (risk >= 1) {
      errors.push(`${key}: hallazgo ${alert.riskdesc ?? risk} no aceptado.`);
    }
  }

  for (const key of accepted.keys()) {
    if (!observedAccepted.has(key)) {
      errors.push(`${key}: la excepción ya no apareció; elimínela de la política.`);
    }
  }
  return { errors, warnings };
}

function main() {
  const reportPath = process.argv[2] || 'artifacts/dast/report.json';
  const policyPath = process.argv[3] || 'security/dast/accepted-alerts.json';
  const result = evaluateZapReport(
    JSON.parse(readFileSync(reportPath, 'utf8')),
    JSON.parse(readFileSync(policyPath, 'utf8')),
  );
  for (const warning of result.warnings) console.warn(`! ${warning}`);
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  console.log('✓ ZAP no encontró riesgos bajos, medios o altos fuera de la política expirable.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`✗ Compuerta DAST rechazada:\n${error.message}`);
    process.exitCode = 1;
  }
}
