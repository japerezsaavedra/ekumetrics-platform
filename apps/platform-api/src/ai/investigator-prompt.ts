export const DEFAULT_INVESTIGATOR_PROMPT = `Eres EkuAssistant, un técnico de operaciones de Ekumetrics.

Hablas como un compañero de turno: claro, directo y en español.
Respondes solo lo que preguntaron. Tienes una ficha medida del host: usa de
ella únicamente lo que contesta la pregunta. No listes el resto.

No inventes un incidente. Si los números están normales o la carga es baja,
dilo en pocas frases: no es un problema. No uses plantillas fijas
(Resumen del problema, Evidencia, Causa, Impacto, Recomendaciones, Nivel de
confianza). Elige el formato que ayude a leer: un párrafo, una lista corta
o una tabla Markdown.

Puedes usar Markdown (tablas, negritas, listas, títulos cortos).

No nombres productos internos de telemetría, paneles ni modelos. Habla de
métricas, registros, servidores y aplicaciones.

Si un dato no aparece en los hechos, di que no hay medición para eso.
No inventes fallos de integración, URLs ni que falte configurar una herramienta.

Si faltan el host o el período para poder responder, pide solo eso.`;

const FACTORY_MARKERS = ['Resumen del problema', 'Nivel de confianza'];

export function isFactoryPrompt(stored?: string | null): boolean {
  const extra = stored?.trim() ?? '';
  if (!extra || extra === DEFAULT_INVESTIGATOR_PROMPT) {
    return true;
  }
  return FACTORY_MARKERS.every((marker) => extra.includes(marker));
}

export function composeInvestigatorPrompt(complement?: string | null): string {
  if (isFactoryPrompt(complement)) {
    return DEFAULT_INVESTIGATOR_PROMPT;
  }
  return `${DEFAULT_INVESTIGATOR_PROMPT}\n\nComplemento del operador:\n${complement?.trim()}`;
}

export function userComplement(stored?: string | null): string {
  if (isFactoryPrompt(stored)) {
    return '';
  }
  return stored?.trim() ?? '';
}

const INTERNAL_NAMES: Array<[RegExp, string]> = [
  [/\bHolmesGPT\b/gi, 'el asistente'],
  [/\bHolmes\b/gi, 'el asistente'],
  [/\bOllama\b/gi, 'el modelo'],
  [/\bPrometheus\b/gi, 'las métricas'],
  [/\bLoki\b/gi, 'los registros'],
  [/\bTempo\b/gi, 'las trazas'],
  [/\bMimir\b/gi, 'las métricas'],
  [/\bGrafana\b/gi, 'los paneles'],
  [/\bOpenTelemetry\b/gi, 'la telemetría'],
  [/\bOTLP\b/g, 'la telemetría'],
  [/\bZabbix\b/gi, 'el monitor'],
];

export function sanitizeAssistantReply(text: string): string {
  const marker = 'Explicacion:';
  const index = text.indexOf(marker);
  let value = (index >= 0 ? text.slice(index + marker.length) : text).trim();
  value = value.replace(/^lectura_experta:\s*/gim, '');
  value = value.replace(/\*?\*?lectura experta\*?\*?\s*[:.\-–]?\s*/gi, '');
  for (const [pattern, replacement] of INTERNAL_NAMES) {
    value = value.replace(pattern, replacement);
  }
  return value.replace(/\n{3,}/g, '\n\n').trim();
}
