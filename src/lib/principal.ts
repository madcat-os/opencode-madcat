/**
 * principal — who is signed in, and which EEMS database is theirs.
 *
 * The madcat menubar keeps a madcat-web desktop session token in
 * `{data_dir}/Madcat/session-<host>.json` (macOS:
 * `~/Library/Application Support/Madcat/`, Linux: `$XDG_DATA_HOME/Madcat/`).
 * We read that token, ask `{web}/api/me` who it belongs to, and derive the
 * user's instanced database the same way the madcat server does
 * (`memory::user_dsn`): `[database].user_dsn` with `{db_name}` filled in, or
 * the base DSN with its database renamed to `{db_name}_{db}`.
 *
 * The token never touches Postgres — it only selects the database. Postgres
 * credentials still come from `[database].dsn`.
 *
 * Resolution is strict: no session file, expired token, 401, unreachable
 * madcat-web or a missing database all throw. Memory, index and the doctrine
 * mirror all require a resolved principal.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import postgres from "postgres"
import { eemsPgDsn, eemsUserDsn, webUrl } from "./config.ts"

export interface Principal {
  id: string
  email: string | null
  name: string | null
  /** madcat-web `users.db_name` (dubs name, e.g. `rough-b-wing-61`). */
  dbName: string
  /** Unix seconds. */
  expiresAt: number
  /** Where the token came from. */
  sessionFile: string
}

export interface ResolvedPrincipal {
  principal: Principal
  /** Instanced DSN (password included — never log). */
  dsn: string
  /** Database name on the server. */
  database: string
  web: string
}

const ME_TTL_MS = 10 * 60 * 1000

/** Platform data dir, matching Rust `dirs::data_dir()`. */
function dataDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support")
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
}

function hostOf(web: string): string {
  const h = web.split("://")[1] ?? web
  return h.replace(/\/+$/, "")
}

/** `~/Library/Application Support/Madcat/session-madcat-os.com.json` */
export function sessionPath(web: string = webUrl()): string {
  const host = [...hostOf(web)]
    .map((c) => (/[a-zA-Z0-9.-]/.test(c) ? c.toLowerCase() : "_"))
    .join("")
  return join(dataDir(), "Madcat", `session-${host}.json`)
}

interface SessionFile {
  access_token: string
  expires_at: number
  id: string
  email?: string | null
  name?: string | null
}

function readSession(web: string, scope = "eems"): { token: string; file: SessionFile; path: string } {
  const path = sessionPath(web)
  if (!existsSync(path)) {
    throw new Error(`${scope}: not signed in — no menubar session at ${path}. Sign in with the Madcat menubar.`)
  }
  let file: SessionFile
  try {
    file = JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    throw new Error(`${scope}: menubar session unreadable at ${path}: ${(e as Error).message}`)
  }
  if (!file.access_token) throw new Error(`${scope}: menubar session at ${path} has no access_token`)
  if (file.expires_at <= Math.floor(Date.now() / 1000)) {
    throw new Error(`${scope}: menubar session expired at ${new Date(file.expires_at * 1000).toISOString()}. Sign in again.`)
  }
  return { token: file.access_token, file, path }
}

/**
 * The signed-in principal's madcat-web bearer token, for services that accept
 * the same desktop session (e.g. madcat-tts with `[tts].auth = "oauth"`).
 * Re-read on every call so a re-sign-in is picked up without a restart.
 * Throws with a sign-in instruction when no valid session exists.
 */
export function sessionToken(scope: string, web: string = webUrl()): string {
  return readSession(web, scope).token
}

/** Postgres identifier for a db_name: lowercase, `-` → `_`, [a-z0-9_]{1,40}. */
export function dbIdent(dbName: string): string {
  const ident = dbName.trim().toLowerCase().replace(/-/g, "_")
  if (!/^[a-z0-9_]{1,40}$/.test(ident)) throw new Error(`eems: db_name ${JSON.stringify(dbName)} cannot name a database`)
  return ident
}

function splitDsn(dsn: string): { prefix: string; db: string; query: string } {
  const m = dsn.match(/^([a-z]+:\/\/[^/]*\/)([^?]*)(\?.*)?$/i)
  if (!m || !m[2]) throw new Error("eems: [database].dsn names no database")
  return { prefix: m[1], db: m[2], query: m[3] ?? "" }
}

/** Instanced DSN for `dbName`: `[database].user_dsn` template, else `{ident}_{db}` on the base server. */
export function userDsn(base: string, dbName: string): { dsn: string; database: string } {
  const ident = dbIdent(dbName)
  const template = eemsUserDsn()
  const dsn = template ? template.replace(/\{db_name\}/g, ident) : (() => {
    const { prefix, db, query } = splitDsn(base)
    return `${prefix}${ident}_${db}${query}`
  })()
  const database = splitDsn(dsn).db
  if (database.length > 63) throw new Error(`eems: database name ${database} is longer than 63 characters`)
  return { dsn, database }
}

// ── /api/me with a per-token cache ──────────────────────────

const meCache = new Map<string, { at: number; me: Record<string, any> }>()

async function fetchMe(web: string, token: string): Promise<Record<string, any>> {
  const key = createHash("sha256").update(token).digest("hex")
  const hit = meCache.get(key)
  if (hit && Date.now() - hit.at < ME_TTL_MS) return hit.me

  let res: Response
  try {
    res = await fetch(`${web}/api/me`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    throw new Error(`eems: ${web}/api/me unreachable: ${(e as Error).message}`)
  }
  if (res.status === 401) throw new Error(`eems: menubar session rejected by ${web} (401). Sign in again.`)
  if (!res.ok) throw new Error(`eems: ${web}/api/me returned ${res.status}`)
  const me = (await res.json()) as Record<string, any>
  meCache.set(key, { at: Date.now(), me })
  return me
}

// ── Resolution ──────────────────────────────────────────────

let resolved: Promise<ResolvedPrincipal> | null = null
let resolvedAt = 0

async function resolveOnce(): Promise<ResolvedPrincipal> {
  const web = webUrl()
  const base = eemsPgDsn()
  if (!base) throw new Error("eems: no Postgres DSN configured ([database].dsn in config.toml)")

  const { token, file, path } = readSession(web)
  const me = await fetchMe(web, token)
  const dbName: string | undefined = me.db_name
  if (!dbName) throw new Error(`eems: ${web}/api/me returned no db_name for ${me.email ?? me.id}`)

  const { dsn, database } = userDsn(base, dbName)

  // Database must already exist — creation is the madcat server's job.
  const probe = postgres(base, { max: 1, connect_timeout: 10, onnotice: () => {} })
  try {
    const rows = await probe`SELECT 1 FROM pg_database WHERE datname = ${database}`
    if (rows.length === 0) {
      throw new Error(`eems: database ${database} for ${me.email ?? dbName} does not exist on the EEMS server`)
    }
  } finally {
    await probe.end({ timeout: 2 })
  }

  return {
    principal: {
      id: me.id ?? file.id,
      email: me.email ?? file.email ?? null,
      name: me.name ?? file.name ?? null,
      dbName,
      expiresAt: me.session?.expires_at ?? file.expires_at,
      sessionFile: path,
    },
    dsn,
    database,
    web,
  }
}

/**
 * Resolve the signed-in principal and their instanced DSN. Cached for
 * ME_TTL_MS; a failed resolution is not cached so the next call retries
 * (e.g. after the operator signs in).
 */
export function resolvePrincipal(): Promise<ResolvedPrincipal> {
  if (resolved && Date.now() - resolvedAt < ME_TTL_MS) return resolved
  resolvedAt = Date.now()
  resolved = resolveOnce().catch((e) => {
    resolved = null
    throw e
  })
  return resolved
}

/** Non-throwing variant for diagnostics (whoami). */
export async function principalStatus(): Promise<
  { ok: true; principal: Principal; database: string } | { ok: false; reason: string; sessionFile: string }
> {
  try {
    const r = await resolvePrincipal()
    return { ok: true, principal: r.principal, database: r.database }
  } catch (e) {
    return { ok: false, reason: (e as Error).message, sessionFile: sessionPath() }
  }
}
