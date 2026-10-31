/**
 * db — singleton Postgres connection for EEMS.
 *
 * Reads DSN from ~/.config/madcat/config.toml [database].dsn.
 * Auto-creates the `locks` table on first use.
 * Uses the `postgres` package (porsager) — pure JS, works in Node + Bun.
 */

import postgres from "postgres"
import { eemsPgDsn } from "./config.ts"

let _sql: ReturnType<typeof postgres> | null = null
let _migrated = false

/** Get or create the singleton Postgres connection. */
export function sql(): ReturnType<typeof postgres> {
  if (_sql) return _sql
  const dsn = eemsPgDsn()
  if (!dsn) throw new Error("No Postgres DSN configured (database.dsn in config.toml)")
  _sql = postgres(dsn, {
    max: 3,
    idle_timeout: 60,
    connect_timeout: 10,
    onnotice: () => {},  // suppress Postgres NOTICE (e.g. "relation already exists, skipping")
  })
  return _sql
}

/** Run migrations (idempotent). Call once at plugin startup or on first lock access. */
export async function migrate(): Promise<void> {
  if (_migrated) return
  const db = sql()
  await db`
    CREATE TABLE IF NOT EXISTS locks (
      name        TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      host        TEXT NOT NULL,
      hostname    TEXT,
      agent       TEXT,
      model       TEXT,
      persona     TEXT,
      platform    TEXT,
      arch        TEXT,
      mesh_url    TEXT,
      claimed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata    JSONB DEFAULT '{}'
    )
  `
  _migrated = true
}

// ── Lock helpers ─────────────────────────────────────────────

export interface LockRow {
  name: string
  session_id: string
  host: string
  hostname: string | null
  agent: string | null
  model: string | null
  persona: string | null
  platform: string | null
  arch: string | null
  mesh_url: string | null
  claimed_at: Date
  metadata: Record<string, any>
}

export interface LockData {
  session_id: string
  host: string
  hostname?: string
  agent?: string
  model?: string
  persona?: string
  platform?: string
  arch?: string
  mesh_url?: string
  metadata?: Record<string, any>
}

/** Upsert a named lock. Overwrites unconditionally. */
export async function acquireLock(name: string, data: LockData): Promise<LockRow | null> {
  await migrate()
  const db = sql()
  const rows = await db`
    INSERT INTO locks (name, session_id, host, hostname, agent, model, persona, platform, arch, mesh_url, metadata, claimed_at)
    VALUES (
      ${name},
      ${data.session_id},
      ${data.host},
      ${data.hostname ?? null},
      ${data.agent ?? null},
      ${data.model ?? null},
      ${data.persona ?? null},
      ${data.platform ?? null},
      ${data.arch ?? null},
      ${data.mesh_url ?? null},
      ${JSON.stringify(data.metadata ?? {})},
      NOW()
    )
    ON CONFLICT (name) DO UPDATE SET
      session_id = EXCLUDED.session_id,
      host       = EXCLUDED.host,
      hostname   = EXCLUDED.hostname,
      agent      = EXCLUDED.agent,
      model      = EXCLUDED.model,
      persona    = EXCLUDED.persona,
      platform   = EXCLUDED.platform,
      arch       = EXCLUDED.arch,
      mesh_url   = EXCLUDED.mesh_url,
      metadata   = EXCLUDED.metadata,
      claimed_at = NOW()
    RETURNING *
  `
  return (rows[0] as LockRow) ?? null
}

/** Read a named lock. Returns null if not held. */
export async function readLock(name: string): Promise<LockRow | null> {
  await migrate()
  const db = sql()
  const rows = await db`SELECT * FROM locks WHERE name = ${name}`
  return (rows[0] as LockRow) ?? null
}

/** Release a named lock. Returns the previous holder or null. */
export async function releaseLock(name: string): Promise<LockRow | null> {
  await migrate()
  const db = sql()
  const rows = await db`DELETE FROM locks WHERE name = ${name} RETURNING *`
  return (rows[0] as LockRow) ?? null
}

/** List all active locks. */
export async function listLocks(): Promise<LockRow[]> {
  await migrate()
  const db = sql()
  return (await db`SELECT * FROM locks ORDER BY name`) as LockRow[]
}

// ── Core schema connection (dual-DSN mode) ──────────────────

let _coreSql: ReturnType<typeof postgres> | null = null

/**
 * Get a Postgres connection to the core schema (EEMS_DSN_CORE).
 * Used for reading persona cart tags and user config in dual-DSN mode.
 * Returns null if EEMS_DSN_CORE is not set.
 */
export function coreSql(): ReturnType<typeof postgres> | null {
  const dsn = process.env.EEMS_DSN_CORE
  if (!dsn) return null
  if (_coreSql) return _coreSql
  _coreSql = postgres(dsn, {
    max: 2,
    idle_timeout: 60,
    connect_timeout: 10,
    onnotice: () => {},
  })
  return _coreSql
}
