#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const { Client } = require(resolve(root, 'apps/platform-api/node_modules/pg'));

export function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function recall(results, expected, field, k = 5) {
  const hits = results.filter((rows, index) =>
    rows.slice(0, k).some((row) => row[field] === expected[index]),
  ).length;
  return expected.length ? hits / expected.length : 0;
}

async function embeddings(url, model, input) {
  const response = await fetch(`${url.replace(/\/$/, '')}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Embeddings respondió HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.embeddings) || body.embeddings.length !== input.length) {
    throw new Error('Respuesta de embeddings incompleta');
  }
  for (const vector of body.embeddings) {
    if (!Array.isArray(vector) || vector.length !== 1024) {
      throw new Error('La evaluación requiere embeddings de 1.024 dimensiones');
    }
  }
  return body.embeddings;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL es obligatorio');
  const embeddingUrl = process.env.AI_EMBEDDING_URL ?? 'http://127.0.0.1:11434';
  const model = process.env.AI_EMBEDDING_MODEL ?? 'qwen3-embedding:0.6b';
  const dataset = JSON.parse(
    await readFile(resolve(root, 'apps/platform-api/test/knowledge-recall.es.json'), 'utf8'),
  );
  const chunks = dataset.documents.flatMap((document) =>
    document.sections.map((section) => ({
      sourceKey: document.sourceKey,
      title: document.title,
      heading: section.heading,
      content: section.content,
    })),
  );
  const vectors = await embeddings(
    embeddingUrl,
    model,
    [...chunks.map((item) => `${item.title}\n${item.heading}\n${item.content}`), ...dataset.questions.map((item) => item.question)],
  );
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const results = [];
  const latencies = [];
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE rag_eval_chunks (
      id bigserial PRIMARY KEY, tenant_id text NOT NULL, source_key text NOT NULL,
      heading text NOT NULL, content text NOT NULL, embedding vector(1024) NOT NULL,
      search_vector tsvector GENERATED ALWAYS AS (to_tsvector('spanish', heading || ' ' || content)) STORED
    ) ON COMMIT DROP`);
    for (const [index, chunk] of chunks.entries()) {
      await client.query(
        'INSERT INTO rag_eval_chunks (tenant_id, source_key, heading, content, embedding) VALUES ($1,$2,$3,$4,$5::vector)',
        ['tenant-a', chunk.sourceKey, chunk.heading, chunk.content, `[${vectors[index].join(',')}]`],
      );
      await client.query(
        'INSERT INTO rag_eval_chunks (tenant_id, source_key, heading, content, embedding) VALUES ($1,$2,$3,$4,$5::vector)',
        ['tenant-b', 'forbidden/cross-tenant', chunk.heading, `${chunk.content} ${dataset.questions[index % dataset.questions.length].question}`, `[${vectors[index].join(',')}]`],
      );
    }
    for (const [index, item] of dataset.questions.entries()) {
      const started = performance.now();
      const vector = vectors[chunks.length + index];
      const response = await client.query(
        `WITH eligible AS (
           SELECT * FROM rag_eval_chunks WHERE tenant_id = $1
         ), lexical AS (
           SELECT id, row_number() OVER (ORDER BY ts_rank_cd(search_vector, plainto_tsquery('spanish', $2)) DESC) rank
           FROM eligible WHERE search_vector @@ plainto_tsquery('spanish', $2) LIMIT 50
         ), semantic AS (
           SELECT id, row_number() OVER (ORDER BY embedding <=> $3::vector) rank FROM eligible LIMIT 50
         ), fused AS (
           SELECT id, sum(score) score FROM (
             SELECT id, 1.0 / (60 + rank) score FROM lexical
             UNION ALL SELECT id, 1.0 / (60 + rank) score FROM semantic
           ) ranks GROUP BY id
         )
         SELECT e.source_key AS "sourceKey", e.heading, f.score::float8 score
         FROM fused f JOIN eligible e ON e.id = f.id ORDER BY f.score DESC LIMIT 5`,
        ['tenant-a', item.question, `[${vector.join(',')}]`],
      );
      latencies.push(performance.now() - started);
      results.push(response.rows);
    }
    const sourceRecall = recall(
      results,
      dataset.questions.map((item) => item.expectedSourceKey),
      'sourceKey',
    );
    const sectionRecall = recall(
      results,
      dataset.questions.map((item) => item.expectedSection),
      'heading',
    );
    const isolationFailures = results.flat().filter((row) => row.sourceKey === 'forbidden/cross-tenant').length;
    const report = {
      dataset: 'knowledge-recall.es.json',
      cases: dataset.questions.length,
      model,
      sourceRecallAt5: sourceRecall,
      sectionRecallAt5: sectionRecall,
      isolationFailures,
      p95QueryMs: Number(percentile(latencies, 0.95).toFixed(2)),
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (sourceRecall < 0.9 || sectionRecall < 0.8 || isolationFailures !== 0) process.exitCode = 1;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`RAG eval falló: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
