export type ToolCallAudit = {
  investigationId: string;
  agentType: string;
  tool: string;
  timestamp: string;
  durationMs: number;
  success: boolean;
  query?: string;
};

const SECRET_KEYS = /password|passwd|secret|api[_-]?key|token|authorization|cookie|bearer/i;

export function sanitizeToolQuery(value: string, max = 500): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .slice(0, max);
}

export function redactSecrets(value: string, max = 2_000): string {
  return sanitizeToolQuery(value, max);
}

export function stripSecretFields(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input)) {
    if (SECRET_KEYS.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = typeof val === 'string' ? redactSecrets(val, 400) : val;
  }
  return out;
}
