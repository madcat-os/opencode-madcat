-- EEMS Postgres + pgvector backend — Phase 3 schema.
-- Target: eems-pg container (pgvector 0.8.2, pg15), database `eems`.
-- Embedding dimension: 1024 (bge-large / bge-m3).
--
-- Idempotent: safe to re-run. Uses IF NOT EXISTS throughout.
-- content_tsv is a generated tsvector column; HNSW + GIN indexes back
-- the hybrid recall (pgvector `<=>` cosine + tsvector `ts_rank`, RRF-fused).

CREATE EXTENSION IF NOT EXISTS vector;

-- ── memories ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memories (
    id              text PRIMARY KEY,
    namespace       text        NOT NULL DEFAULT 'default',
    subject         text        NOT NULL DEFAULT '',
    content         text        NOT NULL DEFAULT '',
    content_hash    text        NOT NULL DEFAULT '',
    classification  text        NOT NULL DEFAULT 'standard',
    confidence      real        NOT NULL DEFAULT 1.0,
    embedding       vector(1024),
    embedding_model text,
    metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at      bigint      NOT NULL DEFAULT 0,
    updated_at      bigint      NOT NULL DEFAULT 0,
    content_tsv     tsvector    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

CREATE INDEX IF NOT EXISTS idx_memories_subject   ON memories (subject);
CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories (namespace);
CREATE INDEX IF NOT EXISTS idx_memories_hash      ON memories (content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_tsv       ON memories USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories
    USING hnsw (embedding vector_cosine_ops);

-- ── edges ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS edges (
    from_id    text   NOT NULL,
    to_id      text   NOT NULL,
    relation   text   NOT NULL,
    weight     real   NOT NULL DEFAULT 1.0,
    created_at bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (from_id, to_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_edges_to ON edges (to_id);
