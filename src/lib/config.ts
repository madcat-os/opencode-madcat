/**
 * Unified config reader — loads ~/.config/madcat/config.toml once,
 * caches it, and exports typed getters.
 *
 * Precedence: env var override → config.toml → hardcoded default.
 * Silent on missing config file — falls back to defaults.
 */

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parse } from "smol-toml"

const CONFIG_PATH = join(homedir(), ".config", "madcat", "config.toml")

let _config: Record<string, any> | null = null

function load(): Record<string, any> {
  if (_config) return _config
  if (!existsSync(CONFIG_PATH)) {
    _config = {}
    return _config
  }
  try {
    _config = parse(readFileSync(CONFIG_PATH, "utf-8"))
  } catch {
    _config = {}
  }
  return _config
}

/** Dot-path lookup into the parsed TOML. Returns undefined if missing. */
function get(path: string): any {
  const parts = path.split(".")
  let cur: any = load()
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined
    cur = cur[p]
  }
  return cur
}

// ── Typed getters (env override → config → default) ─────────

export function eemsDbPath(): string {
  return join(
    homedir(),
    (get("database.path") ?? "~/.local/share/madcat/eems-v2.db")
      .replace(/^~/, "")
  )
}

/** Postgres DSN for EEMS. Env override → config.toml → undefined. */
export function eemsPgDsn(): string | undefined {
  return process.env.EEMS_PG_DSN ?? get("database.dsn") ?? undefined
}

/**
 * `[database].user_dsn` — template for a signed-in user's instanced EEMS
 * database; `{db_name}` is replaced with the sanitised madcat-web db_name.
 * When unset the base DSN's database is renamed to `{db_name}_{db}`.
 */
export function eemsUserDsn(): string | undefined {
  return process.env.EEMS_USER_DSN ?? get("database.user_dsn") ?? undefined
}

/** madcat-web origin — issuer of desktop session tokens (what the menubar keeps). */
export function webUrl(): string {
  return (
    process.env.MADCAT_WEB_URL ??
    get("web.url") ??
    get("mcp.oauth_issuer") ??
    "https://madcat-os.com"
  ).replace(/\/+$/, "")
}

export type EmbedProvider = "ollama" | "openai"

export interface EmbeddingConfig {
  provider: EmbedProvider
  url: string
  model: string
  dimensions: number
  apiKey?: string
}

/**
 * `[embedding]` block, mirroring madcat-memory's EmbeddingConfig::load:
 * provider defaults to ollama; model default depends on provider;
 * api_key falls back to OPENAI_API_KEY.
 */
export function embeddingConfig(): EmbeddingConfig {
  const provider: EmbedProvider = get("embedding.provider") === "openai" ? "openai" : "ollama"
  const url: string = (process.env.MADCAT_EMBED_URL ?? get("embedding.url") ?? "http://localhost:11434").replace(/\/+$/, "")
  const model: string = get("embedding.model") ?? (provider === "openai" ? "bge-m3" : "bge-m3:567m")
  const dimensions: number = Number(get("embedding.dimensions") ?? 1024)
  const apiKey: string | undefined = get("embedding.api_key") ?? process.env.OPENAI_API_KEY ?? undefined
  return { provider, url, model, dimensions, apiKey }
}

export function embedUrl(): string {
  return embeddingConfig().url
}

export function ttsUrl(): string {
  return process.env.MADCAT_TTS_URL ?? get("tts.url") ?? "http://sin:14099"
}

/**
 * `[tts].auth` — how to authenticate against the TTS daemon.
 * `"oauth"`: send the signed-in principal's madcat-web token as a Bearer
 * (`MADCAT_TTS_TOKEN` overrides, for headless hosts without a menubar).
 * `"none"` (default): no Authorization header.
 */
export function ttsAuth(): "oauth" | "none" {
  const v = process.env.MADCAT_TTS_AUTH ?? get("tts.auth") ?? "none"
  return v === "oauth" ? "oauth" : "none"
}

/** Tensors API URL — ComfyUI image generation gateway. Env → config → default. */
export function tensorsUrl(): string {
  return process.env.TENSORS_API_URL ?? get("tensors.url") ?? "http://localhost:51200"
}

export function chatSaidenCartDir(): string {
  return (
    process.env.CHAT_SAIDEN_CART_DIR ??
    get("chat-saiden.operators_dir") ??
    join(homedir(), ".local", "share", "madcat", "chat-saiden", "operators")
  )
}

export interface MeshHost {
  url: string
  username: string
  password: string
}

export function meshHosts(): Record<string, MeshHost> {
  const mesh = get("mesh") ?? {}
  const result: Record<string, MeshHost> = {}
  for (const [name, entry] of Object.entries(mesh) as [string, any][]) {
    if (entry && typeof entry === "object" && entry.url) {
      result[name] = {
        url: entry.url,
        username: entry.username ?? "opencode",
        password: entry.password ?? "",
      }
    }
  }
  return result
}

export function meshHost(name: string): MeshHost {
  const hosts = meshHosts()
  const h = hosts[name]
  if (!h) {
    const available = Object.keys(hosts).join(", ")
    throw new Error(`Host '${name}' not found in config.toml [mesh]. Available: ${available}`)
  }
  return h
}

/** Dynamic host description for tool schemas — e.g. "Target host (fuji, sin, junkpile)" */
export function hostDescription(): string {
  const names = Object.keys(meshHosts())
  return names.length > 0
    ? `Target host (${names.join(", ")})`
    : "Target host"
}

/** Web domain for a mesh host (from [web.domains] in config.toml). */
export function webDomain(host: string): string | undefined {
  return get(`web.domains.${host}`) ?? undefined
}
