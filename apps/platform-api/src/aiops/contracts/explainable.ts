import { isConfidence, type RcaEvidence } from '../types/rca-evidence';

/**
 * Salida explicable compartida (anomalía, RCA, topología, prioridad).
 * Evidence-first: score sin evidencia no es un resultado de producto.
 */
export type ExplainableOutput = {
  score: number;
  confidence: number;
  evidence: RcaEvidence[];
  algorithm: string;
  source?: string;
};

export function createExplainableOutput(
  input: ExplainableOutput,
): ExplainableOutput {
  if (!isConfidence(input.score)) {
    throw new Error('ExplainableOutput.score debe estar en [0, 1].');
  }
  if (!isConfidence(input.confidence)) {
    throw new Error('ExplainableOutput.confidence debe estar en [0, 1].');
  }
  if (!input.algorithm.trim()) {
    throw new Error('ExplainableOutput.algorithm es obligatorio.');
  }
  if (!input.evidence.length) {
    throw new Error('ExplainableOutput requiere evidencia estructurada.');
  }
  return {
    score: input.score,
    confidence: input.confidence,
    evidence: [...input.evidence],
    algorithm: input.algorithm,
    source: input.source,
  };
}
