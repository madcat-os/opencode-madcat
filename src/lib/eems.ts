/**
 * EEMS — Postgres + pgvector memory store, in TypeScript.
 *
 * Port of madcat-memory's pg.rs. The SQL is lifted verbatim:
 * hybrid recall is pgvector cosine (`<=>`) + tsvector `ts_rank`, fused with
 * Reciprocal Rank Fusion (k = 60) in a single round trip. Embeddings come
 * from the remote endpoint in `[embedding]` (see embed.ts).
 *
 * Everything is async — the NAPI predecessor block_on'd every call and
 * stalled the Bun event loop.
 */

import postgres from "postgres"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Embedder, vectorLiteral } from "./embed.ts"

type Sql = ReturnType<typeof postgres>

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, "sql", "eems_init.sql"), "utf8")

// ── Types (shape matches the former NAPI surface) ───────────

export interface StoreParams {
  subject: string
  content: string
  namespace?: string
  classification?: string
  confidence?: number
  /** JSON object or a JSON string. */
  metadata?: Record<string, unknown> | string
}

export interface RecallParams {
  query: string
  namespace?: string
  subject?: string
  limit?: number
}

export interface LinkParams {
  fromId: string
  toId: string
  relation: string
  weight?: number
}

export interface Memory {
  id: string
  namespace: string
  subject: string
  content: string
  classification: string
  confidence: number
  /** JSON string — kept as the NAPI layer returned it. */
  metadata: string
  createdAt: number
  updatedAt: number
}

export interface RecallHit {
  memory: Memory
  score: number
}

export interface Edge {
  fromId: string
  toId: string
  relation: string
  weight: number
  createdAt: number
}

export interface GraphNode {
  memory: Memory
  edges: Edge[]
  depth: number
}

export interface SubjectCount {
  subject: string
  count: number
}

// ── Helpers ─────────────────────────────────────────────────

export function contentHash(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

const ULID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

/** Lowercase ULID (Crockford base32): 10 chars time + 16 chars randomness. */
export function ulid(now = Date.now()): string {
  let t = now
  let time = ""
  for (let i = 0; i < 10; i++) {
    time = ULID_ALPHABET[t % 32] + time
    t = Math.floor(t / 32)
  }
  const rnd = randomBytes(16)
  let rand = ""
  for (let i = 0; i < 16; i++) rand += ULID_ALPHABET[rnd[i] % 32]
  return time + rand
}

/** Millisecond timestamp encoded in a ULID's first 10 chars. */
export function ulidTime(id: string): number {
  let t = 0
  for (let i = 0; i < 10; i++) {
    const v = ULID_ALPHABET.indexOf(id[i])
    if (v < 0) return NaN
    t = t * 32 + v
  }
  return t
}

function connect(dsn: string): Sql {
  return postgres(dsn, {
    max: 8,
    idle_timeout: 60,
    connect_timeout: 10,
    onnotice: () => {},
  })
}

/** Run the idempotent schema once per connection. Surfaces a readable error. */
async function migrate(sql: Sql, dsn: string): Promise<void> {
  try {
    await sql.unsafe(SCHEMA_SQL)
  } catch (e) {
    const db = dsn.replace(/^.*\/([^/?]+)(\?.*)?$/, "$1")
    throw new Error(`eems: schema migration failed on ${db}: ${(e as Error).message}`)
  }
}

function rowToMemory(r: Record<string, any>): Memory {
  return {
    id: r.id,
    namespace: r.namespace,
    subject: r.subject,
    content: r.content,
    classification: r.classification,
    confidence: Number(r.confidence),
    metadata: JSON.stringify(r.metadata ?? null),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

// ── Static SQL (verbatim from the Rust crate) ───────────────

const RECALL_SQL = `
    WITH params AS (
        SELECT $1::vector AS qvec,
               $2::text   AS qtext,
               $3::int    AS fetch_n,
               $4::text   AS ns,
               $5::text   AS subj
    ),
    filtered AS (
        SELECT m.* FROM memories m, params p
        WHERE (p.ns   IS NULL OR m.namespace = p.ns)
          AND (p.subj IS NULL OR m.subject   = p.subj)
    ),
    vec_ranked AS (
        SELECT f.id,
               row_number() OVER (
                   ORDER BY f.embedding <=> p.qvec ASC
               ) AS rnk
        FROM filtered f, params p
        WHERE f.embedding IS NOT NULL
        ORDER BY f.embedding <=> p.qvec ASC
        LIMIT (SELECT fetch_n FROM params)
    ),
    fts_ranked AS (
        SELECT f.id,
               row_number() OVER (
                   ORDER BY ts_rank(
                       f.content_tsv,
                       websearch_to_tsquery('english', p.qtext)
                   ) DESC
               ) AS rnk
        FROM filtered f, params p
        WHERE f.content_tsv @@ websearch_to_tsquery('english', p.qtext)
        ORDER BY ts_rank(
                     f.content_tsv,
                     websearch_to_tsquery('english', p.qtext)
                 ) DESC
        LIMIT (SELECT fetch_n FROM params)
    ),
    fused AS (
        SELECT id, SUM(score)::double precision AS score FROM (
            SELECT id, (1.0 / (60.0 + rnk))::double precision AS score FROM vec_ranked
            UNION ALL
            SELECT id, (1.0 / (60.0 + rnk))::double precision AS score FROM fts_ranked
        ) u
        GROUP BY id
    )
    SELECT m.id, m.namespace, m.subject, m.content, m.classification,
           m.confidence, m.metadata, m.created_at, m.updated_at,
           fused.score
    FROM fused
    JOIN memories m ON m.id = fused.id
    ORDER BY fused.score DESC
    LIMIT $6
`

// ── Shared connection registry ──────────────────────────────

const connections = new Map<string, { sql: Sql; ready: Promise<void> }>()

/** One pool + one migration per DSN. */
function pool(dsn: string): { sql: Sql; ready: Promise<void> } {
  let c = connections.get(dsn)
  if (!c) {
    const sql = connect(dsn)
    const ready = migrate(sql, dsn).catch((e) => {
      connections.delete(dsn)
      void sql.end({ timeout: 1 })
      throw e
    })
    c = { sql, ready }
    connections.set(dsn, c)
  }
  return c
}

// ── MemoryStore ─────────────────────────────────────────────

export class MemoryStore {
  private readonly sql: Sql
  private readonly ready: Promise<void>
  private readonly embed: Embedder

  constructor(readonly dsn: string, embed: Embedder = new Embedder()) {
    const c = pool(dsn)
    this.sql = c.sql
    this.ready = c.ready
    this.embed = embed
  }

  /** Resolves once the schema is in place; rejects if the DB is unreachable. */
  open(): Promise<void> {
    return this.ready
  }

  /** Store a memory. Embeds content, dedups by content hash. Returns the ID. */
  async store(p: StoreParams): Promise<string> {
    await this.ready
    const ns = p.namespace ?? "default"
    const cls = p.classification ?? "standard"
    const conf = p.confidence ?? 1.0
    const meta: unknown = typeof p.metadata === "string" ? JSON.parse(p.metadata) : (p.metadata ?? {})
    const hash = contentHash(p.content)

    const existing = await this.sql`
      SELECT id FROM memories WHERE namespace = ${ns} AND subject = ${p.subject} AND content_hash = ${hash} LIMIT 1`
    if (existing.length) return existing[0].id as string

    const vec = await this.embed.embedOne(p.content)
    const now = Date.now()
    const id = ulid(now)
    await this.sql`
      INSERT INTO memories
        (id, namespace, subject, content, content_hash, classification,
         confidence, embedding, embedding_model, metadata, created_at, updated_at)
      VALUES (${id}, ${ns}, ${p.subject}, ${p.content}, ${hash}, ${cls},
              ${conf}, ${vectorLiteral(vec)}::vector, ${this.embed.modelId},
              ${this.sql.json(meta as any)}, ${now}, ${now})`
    return id
  }

  /** Hybrid recall: pgvector cosine + tsvector ts_rank, RRF-fused in SQL. */
  async recall(p: RecallParams): Promise<RecallHit[]> {
    await this.ready
    const limit = p.limit ?? 10
    const fetch = Math.max(limit * 3, 30)
    const qv = await this.embed.embedOne(p.query)
    const rows = await this.sql.unsafe(RECALL_SQL, [
      vectorLiteral(qv),
      p.query,
      fetch,
      p.namespace ?? null,
      p.subject ?? null,
      limit,
    ])
    return rows.map((r) => ({ memory: rowToMemory(r), score: Number(r.score) }))
  }

  async get(ids: string[]): Promise<Memory[]> {
    await this.ready
    if (ids.length === 0) return []
    const rows = await this.sql`
      SELECT id, namespace, subject, content, classification, confidence, metadata, created_at, updated_at
      FROM memories WHERE id = ANY(${ids})`
    return rows.map(rowToMemory)
  }

  async forget(id: string): Promise<boolean> {
    await this.ready
    const res = await this.sql`DELETE FROM memories WHERE id = ${id}`
    return res.count > 0
  }

  async classify(id: string, classification: string): Promise<void> {
    await this.ready
    const res = await this.sql`
      UPDATE memories SET classification = ${classification}, updated_at = ${Date.now()} WHERE id = ${id}`
    if (res.count === 0) throw new Error(`memory not found: ${id}`)
  }

  async listSubjects(namespace?: string): Promise<SubjectCount[]> {
    await this.ready
    const rows = await this.sql`
      SELECT subject, COUNT(*)::bigint AS cnt FROM memories
      WHERE (${namespace ?? null}::text IS NULL OR namespace = ${namespace ?? null})
      GROUP BY subject ORDER BY cnt DESC`
    return rows.map((r) => ({ subject: r.subject, count: Number(r.cnt) }))
  }

  async link(p: LinkParams): Promise<void> {
    await this.ready
    await this.sql`
      INSERT INTO edges (from_id, to_id, relation, weight, created_at)
      VALUES (${p.fromId}, ${p.toId}, ${p.relation}, ${p.weight ?? 1.0}, ${Date.now()})
      ON CONFLICT (from_id, to_id, relation)
      DO UPDATE SET weight = EXCLUDED.weight, created_at = EXCLUDED.created_at`
  }

  async graph(id: string, depth = 2): Promise<GraphNode[]> {
    await this.ready
    const visited = new Map<string, number>()
    const queue: [string, number][] = [[id, 0]]
    const result: GraphNode[] = []

    while (queue.length) {
      const [cur, d] = queue.pop()!
      if (d > depth || visited.has(cur)) continue
      visited.set(cur, d)

      const [mem] = await this.get([cur])
      if (!mem) continue

      const edges = await this.edgesFor(cur)
      for (const e of edges) {
        const neighbor = e.fromId === cur ? e.toId : e.fromId
        if (!visited.has(neighbor)) queue.push([neighbor, d + 1])
      }
      result.push({ memory: mem, edges, depth: d })
    }
    return result
  }

  private async edgesFor(id: string): Promise<Edge[]> {
    const rows = await this.sql`
      SELECT from_id, to_id, relation, weight, created_at FROM edges WHERE from_id = ${id} OR to_id = ${id}`
    return rows.map((r) => ({
      fromId: r.from_id,
      toId: r.to_id,
      relation: r.relation,
      weight: Number(r.weight),
      createdAt: Number(r.created_at),
    }))
  }
}
