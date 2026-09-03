import assert from 'node:assert/strict';
import test from 'node:test';
import { percentile, recall } from './rag-evaluate.mjs';

test('recall@k mide presencia del resultado esperado', () => {
  const results = [[{ sourceKey: 'a' }], [{ sourceKey: 'x' }, { sourceKey: 'b' }]];
  assert.equal(recall(results, ['a', 'b'], 'sourceKey', 2), 1);
  assert.equal(recall(results, ['a', 'b'], 'sourceKey', 1), 0.5);
});

test('percentil usa el rango superior observado', () => {
  assert.equal(percentile([5, 1, 9, 3], 0.95), 9);
  assert.equal(percentile([], 0.95), 0);
});
