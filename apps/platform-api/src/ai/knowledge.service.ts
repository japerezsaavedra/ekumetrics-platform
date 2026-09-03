import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

export type KnowledgeSourceType = 'product' | 'runbook' | 'postmortem';

export type KnowledgeDocumentInput = {
  sourceKey: string;
  sourceType: KnowledgeSourceType;
  title: string;
  version: string;
  component?: string;
  content: string;
  validFrom?: string;
  validUntil?: string;
};

type KnowledgeRow = {
  id: string;
  documentId: string;
  sourceKey: string;
  sourceType: KnowledgeSourceType;
  title: string;
  version: string;
  component: string | null;
  heading: string | null;
  content: string;
  approvedAt: Date;
  score: number;
};

type KnowledgeDocumentRow = {
  id: string;
  sourceKey: string;
  sourceType: KnowledgeSourceType;
  title: string;
  version: string;
  component: string | null;
  checksum: string;
  approvedBy: string;
  approvedAt: Date;
  validFrom: Date;
  validUntil: Date | null;
  updatedAt: Date;
  chunkCount: bigint;
};

@Injectable()
export class KnowledgeService {
  private readonly embeddingUrl: string;
  private readonly embeddingModel: string;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.embeddingUrl = (
      config.get<string>('AI_EMBEDDING_URL') ?? 'http://ollama:11434'
    ).replace(/\/$/, '');
    this.embeddingModel =
      config.get<string>('AI_EMBEDDING_MODEL') ?? 'qwen3-embedding:0.6b';
  }

  async upsertDocument(
    tenantSlug: string,
    actor: string,
    input: KnowledgeDocumentInput,
  ) {
    const tenant = await this.authorizeTenant(tenantSlug, actor);
    const document = this.document(input);
    const chunks = this.chunk(document.content);
    const embeddings = await this.embed(
      chunks.map((item) => item.content),
      true,
    );
    const id = randomUUID();
    const now = new Date();
    const validFrom = document.validFrom
      ? this.date(document.validFrom, 'validFrom')
      : now;
    const validUntil = document.validUntil
      ? this.date(document.validUntil, 'validUntil')
      : null;
    if (validUntil && validUntil <= validFrom) {
      throw new BadRequestException(
        'validUntil debe ser posterior a validFrom.',
      );
    }
    const writes = [
      this.prisma.$executeRawUnsafe(
        'DELETE FROM "AiKnowledgeDocument" WHERE "tenantId" = $1 AND "sourceKey" = $2',
        tenant.id,
        document.sourceKey,
      ),
      this.prisma.$executeRawUnsafe(
        `INSERT INTO "AiKnowledgeDocument"
          ("id", "tenantId", "sourceKey", "sourceType", "title", "version", "component", "checksum", "approvedBy", "approvedAt", "validFrom", "validUntil", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$10)`,
        id,
        tenant.id,
        document.sourceKey,
        document.sourceType,
        document.title,
        document.version,
        document.component || null,
        this.sha256(document.content),
        actor.trim().toLowerCase(),
        now,
        validFrom,
        validUntil,
      ),
      ...chunks.map((chunk, index) =>
        this.prisma.$executeRawUnsafe(
          `INSERT INTO "AiKnowledgeChunk"
            ("id", "documentId", "ordinal", "heading", "content", "contentHash", "tokenCount", "embeddingModel", "embedding")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector)`,
          randomUUID(),
          id,
          index,
          chunk.heading,
          chunk.content,
          this.sha256(chunk.content),
          this.estimatedTokens(chunk.content),
          this.embeddingModel,
          this.vector(embeddings[index]),
        ),
      ),
    ];
    await this.prisma.$transaction(writes);
    return {
      id,
      sourceKey: document.sourceKey,
      version: document.version,
      chunks: chunks.length,
      checksum: this.sha256(document.content),
      approvedAt: now.toISOString(),
    };
  }

  async deleteDocument(tenantSlug: string, actor: string, idInput: string) {
    const tenant = await this.authorizeTenant(tenantSlug, actor);
    const id = this.identifier(idInput, 'documentId', 128);
    const count = await this.prisma.$executeRawUnsafe(
      'DELETE FROM "AiKnowledgeDocument" WHERE "id" = $1 AND "tenantId" = $2',
      id,
      tenant.id,
    );
    if (!count)
      throw new ForbiddenException('Documento no encontrado en el tenant.');
    return { deleted: true };
  }

  async listDocuments(tenantSlug: string, actor: string) {
    const tenant = await this.authorizeTenant(tenantSlug, actor);
    const rows = await this.prisma.$queryRawUnsafe<KnowledgeDocumentRow[]>(
      `SELECT d."id", d."sourceKey", d."sourceType", d."title", d."version", d."component",
              d."checksum", d."approvedBy", d."approvedAt", d."validFrom", d."validUntil",
              d."updatedAt", count(c."id") AS "chunkCount"
       FROM "AiKnowledgeDocument" d
       LEFT JOIN "AiKnowledgeChunk" c ON c."documentId" = d."id"
       WHERE d."tenantId" = $1 AND d."deletedAt" IS NULL
       GROUP BY d."id" ORDER BY d."updatedAt" DESC LIMIT 200`,
      tenant.id,
    );
    const now = Date.now();
    return rows.map((row) => ({
      ...row,
      chunkCount: Number(row.chunkCount),
      approvedAt: row.approvedAt.toISOString(),
      validFrom: row.validFrom.toISOString(),
      validUntil: row.validUntil?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      status:
        row.validFrom.getTime() > now
          ? ('scheduled' as const)
          : row.validUntil && row.validUntil.getTime() <= now
            ? ('expired' as const)
            : ('active' as const),
    }));
  }

  async search(tenantSlug: string, actor: string, question: string, limit = 8) {
    const tenant = await this.authorizeTenant(tenantSlug, actor);
    const query = this.text(question, 'question', 2_000);
    const safeLimit = Number.isInteger(limit)
      ? Math.min(20, Math.max(1, limit))
      : 8;
    const embedding = (await this.embed([query], false))[0];
    const rows = embedding
      ? await this.hybridRows(tenant.id, query, embedding, safeLimit)
      : await this.lexicalRows(tenant.id, query, safeLimit);
    return rows.map((row) => ({
      documentId: row.documentId,
      sourceKey: row.sourceKey,
      sourceType: row.sourceType,
      title: row.title,
      version: row.version,
      component: row.component,
      section: row.heading,
      approvedAt: row.approvedAt.toISOString(),
      excerpt: row.content.slice(0, 1_600),
      score: Number(row.score.toFixed(6)),
    }));
  }

  private async hybridRows(
    tenantId: string,
    query: string,
    embedding: number[],
    limit: number,
  ): Promise<KnowledgeRow[]> {
    return this.prisma.$queryRawUnsafe<KnowledgeRow[]>(
      `WITH eligible AS (
         SELECT c.*, d."sourceKey", d."sourceType", d."title", d."version", d."component", d."approvedAt"
         FROM "AiKnowledgeChunk" c JOIN "AiKnowledgeDocument" d ON d."id" = c."documentId"
         WHERE d."tenantId" = $1 AND d."deletedAt" IS NULL
           AND d."validFrom" <= now() AND (d."validUntil" IS NULL OR d."validUntil" > now())
       ), lexical AS (
         SELECT "id", row_number() OVER (ORDER BY ts_rank_cd("searchVector", plainto_tsquery('spanish', $2)) DESC) AS rank
         FROM eligible WHERE "searchVector" @@ plainto_tsquery('spanish', $2) LIMIT 50
       ), semantic AS (
         SELECT "id", row_number() OVER (ORDER BY "embedding" <=> $3::vector) AS rank
         FROM eligible WHERE "embedding" IS NOT NULL LIMIT 50
       ), fused AS (
         SELECT "id", sum(score) AS score FROM (
           SELECT "id", 1.0 / (60 + rank) AS score FROM lexical
           UNION ALL
           SELECT "id", 1.0 / (60 + rank) AS score FROM semantic
         ) ranks GROUP BY "id"
       )
       SELECT e."id", e."documentId", e."sourceKey", e."sourceType", e."title", e."version",
              e."component", e."heading", e."content", e."approvedAt", f.score::float8 AS score
       FROM fused f JOIN eligible e ON e."id" = f."id"
       ORDER BY f.score DESC, e."ordinal" ASC LIMIT $4`,
      tenantId,
      query,
      this.vector(embedding),
      limit,
    );
  }

  private async lexicalRows(tenantId: string, query: string, limit: number) {
    return this.prisma.$queryRawUnsafe<KnowledgeRow[]>(
      `SELECT c."id", c."documentId", d."sourceKey", d."sourceType", d."title", d."version",
              d."component", c."heading", c."content", d."approvedAt",
              ts_rank_cd(c."searchVector", plainto_tsquery('spanish', $2))::float8 AS score
       FROM "AiKnowledgeChunk" c JOIN "AiKnowledgeDocument" d ON d."id" = c."documentId"
       WHERE d."tenantId" = $1 AND d."deletedAt" IS NULL
         AND d."validFrom" <= now() AND (d."validUntil" IS NULL OR d."validUntil" > now())
         AND c."searchVector" @@ plainto_tsquery('spanish', $2)
       ORDER BY score DESC, c."ordinal" ASC LIMIT $3`,
      tenantId,
      query,
      limit,
    );
  }

  private async embed(input: string[], required: boolean): Promise<number[][]> {
    try {
      const response = await fetch(`${this.embeddingUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.embeddingModel, input }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { embeddings?: unknown };
      if (
        !Array.isArray(body.embeddings) ||
        body.embeddings.length !== input.length
      ) {
        throw new Error('respuesta de embeddings incompleta');
      }
      return body.embeddings.map((value) => this.embedding(value));
    } catch (error) {
      if (!required) return [];
      throw new ServiceUnavailableException(
        `No fue posible indexar conocimiento con ${this.embeddingModel}: ${error instanceof Error ? error.message : 'error desconocido'}`,
      );
    }
  }

  private embedding(value: unknown): number[] {
    if (!Array.isArray(value) || value.length !== 1_024) {
      throw new Error('el embedding debe tener 1024 dimensiones');
    }
    const numbers = value.map(Number);
    if (numbers.some((item) => !Number.isFinite(item))) {
      throw new Error('el embedding contiene valores invalidos');
    }
    return numbers;
  }

  private chunk(content: string) {
    const sections: Array<{ heading: string | null; content: string }> = [];
    let heading: string | null = null;
    let buffer: string[] = [];
    const flush = () => {
      const body = buffer.join('\n').trim();
      if (!body) return;
      for (let start = 0; start < body.length; start += 2_700) {
        sections.push({ heading, content: body.slice(start, start + 3_000) });
      }
      buffer = [];
    };
    for (const line of content.split(/\r?\n/)) {
      const match = /^(#{1,6})\s+(.+)$/.exec(line.trim());
      if (match) {
        flush();
        heading = match[2].trim().slice(0, 300);
      } else {
        buffer.push(line);
      }
    }
    flush();
    if (!sections.length)
      throw new BadRequestException('content no contiene texto indexable.');
    if (sections.length > 200) {
      throw new BadRequestException('content genera mas de 200 fragmentos.');
    }
    return sections;
  }

  private document(input: KnowledgeDocumentInput): KnowledgeDocumentInput {
    if (!['product', 'runbook', 'postmortem'].includes(input.sourceType)) {
      throw new BadRequestException('sourceType no permitido.');
    }
    return {
      sourceKey: this.identifier(input.sourceKey, 'sourceKey', 200),
      sourceType: input.sourceType,
      title: this.text(input.title, 'title', 300),
      version: this.identifier(input.version, 'version', 80),
      component: input.component
        ? this.identifier(input.component, 'component', 120)
        : undefined,
      content: this.text(input.content, 'content', 200_000),
      validFrom: input.validFrom,
      validUntil: input.validUntil,
    };
  }

  private async authorizeTenant(slugInput: string, actor: string) {
    const slug = this.identifier(slugInput, 'tenant', 80);
    if (!actor.trim()) throw new ForbiddenException('Actor requerido.');
    const tenant = await this.prisma.tenant.findUnique({ where: { slug } });
    if (!tenant) throw new ForbiddenException('Tenant no autorizado.');
    return tenant;
  }

  private identifier(value: string, field: string, max: number) {
    const clean = value?.trim();
    if (!clean || clean.length > max || !/^[A-Za-z0-9._:/-]+$/.test(clean)) {
      throw new BadRequestException(`${field} invalido.`);
    }
    return clean;
  }

  private text(value: string, field: string, max: number) {
    const clean = value?.trim();
    if (
      !clean ||
      clean.length > max ||
      clean.includes(String.fromCharCode(0))
    ) {
      throw new BadRequestException(`${field} invalido.`);
    }
    return clean;
  }

  private date(value: string, field: string) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()))
      throw new BadRequestException(`${field} invalido.`);
    return date;
  }

  private estimatedTokens(value: string) {
    return Math.max(1, Math.ceil(value.length / 4));
  }

  private sha256(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private vector(value: number[]) {
    return `[${value.join(',')}]`;
  }
}
