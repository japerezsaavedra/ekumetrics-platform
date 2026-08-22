const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const STEPS = [
  1_000,
  5_000,
  10_000,
  15_000,
  30_000,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
];

const TARGET_TICKS = 8;

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function timeAxisStep(rangeMs: number): number {
  const ideal = Math.max(1, rangeMs) / TARGET_TICKS;
  return STEPS.find((step) => step >= ideal) ?? STEPS[STEPS.length - 1];
}

export function timeAxisLabel(ts: number, step: number): string {
  const date = new Date(ts);
  if (step < MINUTE) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
  if (step < DAY) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
}

/**
 * Marcas en instantes redondos (hora local) dentro de la ventana visible.
 * Al desplazarse la ventana las marcas se mueven a la par, sin saltos.
 */
export function timeAxisTicks(min: number, max: number): number[] {
  const step = timeAxisStep(max - min);
  const offset = new Date(min).getTimezoneOffset() * MINUTE;
  const values: number[] = [];
  for (let ts = Math.ceil((min + offset) / step) * step - offset; ts <= max; ts += step) {
    values.push(ts);
  }
  return values;
}
