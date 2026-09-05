import type { MetricPoint } from './metric-sample';

export function finitePoints(points: MetricPoint[]): MetricPoint[] {
  return points
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value))
    .slice()
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function valuesOf(points: MetricPoint[]): number[] {
  return finitePoints(points).map((point) => point.value);
}

function sorted(values: number[]): number[] {
  return values.filter(Number.isFinite).slice().sort((left, right) => left - right);
}

export function mean(values: number[]): number | null {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

export function median(values: number[]): number | null {
  return quantile(values, 0.5);
}

export function quantile(values: number[], p: number): number | null {
  const data = sorted(values);
  if (!data.length) return null;
  if (p <= 0) return data[0];
  if (p >= 1) return data[data.length - 1];
  if (data.length === 1) return data[0];
  const index = (data.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return data[low];
  const weight = index - low;
  return data[low] * (1 - weight) + data[high] * weight;
}

export function stddev(values: number[]): number | null {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return null;
  const center = mean(finite);
  if (center == null) return null;
  const variance =
    finite.reduce((sum, value) => sum + (value - center) ** 2, 0) /
    (finite.length - 1);
  return Math.sqrt(variance);
}

export function mad(values: number[], center?: number): number | null {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  const mid = center ?? median(finite);
  if (mid == null) return null;
  return median(finite.map((value) => Math.abs(value - mid)));
}

export function iqr(values: number[]): number | null {
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  if (q1 == null || q3 == null) return null;
  return q3 - q1;
}

export function percentile(values: number[], p: number): number | null {
  return quantile(values, p);
}

export function robustScale(values: number[]): number | null {
  const spread = iqr(values);
  const scaledIqr = spread != null && spread > 0 ? spread / 1.349 : null;
  const scaledMad = mad(values);
  const fromMad =
    scaledMad != null && scaledMad > 0 ? scaledMad * 1.4826 : null;
  if (scaledIqr != null && fromMad != null) {
    return Math.max(scaledIqr, fromMad);
  }
  return scaledIqr ?? fromMad;
}

export function sampleConfidence(sampleCount: number, minSamples: number): number {
  if (sampleCount <= 0) return 0;
  const needed = Math.max(minSamples, 1);
  return Math.min(1, sampleCount / (needed * 2));
}

export function lastPoint(points: MetricPoint[]): MetricPoint | null {
  const finite = finitePoints(points);
  return finite.length ? finite[finite.length - 1] : null;
}

export function baselinePoints(points: MetricPoint[]): MetricPoint[] {
  const finite = finitePoints(points);
  if (finite.length <= 1) return [];
  return finite.slice(0, -1);
}
