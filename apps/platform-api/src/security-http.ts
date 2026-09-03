type RuntimeEnvironment = Record<string, string | undefined>;

const LOCAL_ORIGINS = ['http://localhost:4200', 'http://127.0.0.1:4200'];

function normalizeOrigin(value: string, production: boolean): string {
  if (value === '*') throw new Error('CORS_ORIGIN no admite wildcard.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Origen CORS inválido: ${value}`);
  }
  if (url.origin !== value.replace(/\/$/, '') || url.username || url.password) {
    throw new Error(
      `CORS_ORIGIN debe contener solo scheme, host y puerto: ${value}`,
    );
  }
  if (production && url.protocol !== 'https:') {
    throw new Error(`CORS_ORIGIN productivo debe usar HTTPS: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Protocolo CORS no permitido: ${url.protocol}`);
  }
  return url.origin;
}

export function corsOrigins(
  environment: RuntimeEnvironment = process.env,
): string[] {
  const production = environment.DEPLOYMENT_MODE === 'production';
  const configured = (environment.CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => normalizeOrigin(origin, production));
  if (production && configured.length === 0) {
    throw new Error('CORS_ORIGIN es obligatorio en producción.');
  }
  return [
    ...new Set(production ? configured : [...configured, ...LOCAL_ORIGINS]),
  ];
}
