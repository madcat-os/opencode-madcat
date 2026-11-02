/**
 * whoami — single source of truth for agent identity at session boot.
 *
 * Returns: session context, mode (foreground/background), persona from
 * the active cart, mesh topology, host hardware, available tools for
 * the current agent, comms rules, and memory guidance.
 *
 * Everything the agent needs to know comes from here — no inference,
 * no guessing, no duplicate prompts.
 */

import { tool } from "../lib/tool"
import { hostname, platform, arch, homedir, cpus, totalmem } from "node:os"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { parse } from "smol-toml"
import { meshHosts, webDomain } from "../lib/config.ts"
import { readLock, coreSql } from "../lib/db.ts"
import { hasDualDsn } from "../lib/user-resolver.ts"
import { dsnRole, principalStatus, sessionPath } from "../lib/principal.ts"
import { eemsMode, sharedDsn } from "../lib/native.ts"
import { Buffer } from "node:buffer"
import type { ToolContext } from "../lib/identity"

const CARTS_DIR = join(homedir(), ".config", "madcat", "carts")
const TTS_STATE = join(homedir(), ".local", "share", "madcat", "tts-state.toml")

/** Load a cart TOML by tag. */
function loadCart(tag: string): Record<string, any> | null {
  const path = join(CARTS_DIR, `${tag}.toml`)
  if (!existsSync(path)) return null
  try {
    return parse(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

/** Read the persona state file to get the active cart tag (single-tenant fallback). */
function globalCartTag(): string | null {
  try {
    const state = parse(readFileSync(TTS_STATE, "utf-8"))
    return (state as any).active_cart ?? null
  } catch {
    return null
  }
}

/**
 * Resolve the cart tag for this session.
 * Dual-DSN: reads persona_cart_tag from the core schema config table.
 * Single-DSN: global tts-state.toml.
 */
async function resolveCartTag(): Promise<string | null> {
  if (hasDualDsn()) {
    try {
      const db = coreSql()
      if (db) {
        const rows = await db`
          SELECT value FROM config WHERE key = 'persona_cart_tag' LIMIT 1
        `
        const tag = rows[0]?.value as string | undefined
        if (tag) return tag
      }
    } catch (err) {
      console.error(`[whoami] dual-DSN cart lookup failed:`, (err as Error)?.message ?? err)
    }
  }
  return globalCartTag()
}

/** Resolve mesh name for this host. */
function selfMeshName(): string {
  try {
    const hosts = meshHosts()
    for (const [name, entry] of Object.entries(hosts)) {
      if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(entry.url)) return name
    }
  } catch {}
  return hostname()
}

/** Build mesh topology from config.toml [mesh.*] entries. */
function meshTopology(): Record<string, any> {
  try {
    const hosts = meshHosts()
    const result: Record<string, any> = {}
    for (const [name, entry] of Object.entries(hosts)) {
      result[name] = { url: entry.url }
    }
    return result
  } catch {
    return {}
  }
}

/** Concise hardware summary. */
function hardware(): { cpu: string; cores: number; ram_gb: number } {
  const c = cpus()
  return {
    cpu: c[0]?.model?.trim() ?? "unknown",
    cores: c.length,
    ram_gb: Math.round(totalmem() / 1073741824),
  }
}

/** Which EEMS database this host's memory calls land in, and as whom. */
function eemsBlock(
  route: ReturnType<typeof eemsMode>,
  status: Awaited<ReturnType<typeof principalStatus>> | null,
  context: ToolContext,
): Record<string, unknown> {
  if (route === "dual-dsn") return { mode: "dual-dsn", agent: context.agent === "double" ? "double" : "core" }
  if (route === "shared") {
    let role: string | null = null
    let reason: string | null = null
    try {
      role = dsnRole(sharedDsn())
    } catch (e) {
      reason = (e as Error).message
    }
    return reason
      ? { mode: "unavailable", reason, fix: "Set [database].dsn in config.toml, or sign in with the Madcat menubar." }
      : {
          mode: "shared",
          role,
          note: `No menubar session at ${sessionPath()}; using the global [database].dsn. Sign in to use your own database.`,
        }
  }
  if (status?.ok) {
    return {
      mode: "principal",
      user: status.principal.email ?? status.principal.id,
      database: status.database,
      role: status.role,
      access: status.access,
      ...(status.access === "derived"
        ? { note: "madcat-web returned no db_url; connected with shared [database].dsn credentials." }
        : {}),
      session_expires: new Date(status.principal.expiresAt * 1000).toISOString(),
    }
  }
  return {
    mode: "unavailable",
    reason: status?.reason ?? "unknown",
    fix: "A menubar session exists but did not resolve. Sign in again with the Madcat menubar; memory_* tools will not fall back to the shared store.",
  }
}

export const info = tool({
  description:
    "Identify the current agent session — session ID, host, agent, model, persona, " +
    "mode (foreground/background), mesh topology, available tools, comms rules, and " +
    "memory guidance. Run at session start. This is the single source of truth.",
  args: {},
  async execute(_args: {}, context: ToolContext) {
    const now = new Date()
    const self = selfMeshName()
    const eemsRoute = eemsMode()
    const [primeLock, eems] = await Promise.all([
      readLock("prime").catch(() => null),
      eemsRoute === "principal" ? principalStatus() : Promise.resolve(null),
    ])
    const primeHolder = primeLock?.session_id ?? null
    const isPrime = primeHolder === context.sessionID
    const mode = isPrime ? "foreground" : "background"

    // Load the active cart for persona
    const cartTag = await resolveCartTag()
    const cart = cartTag ? loadCart(cartTag) : null
    const persona = cart?.persona ?? null

    // Build persona block — strip null fields to save tokens
    const personaRaw = persona
      ? {
          name: persona.name ?? cartTag,
          tagline: persona.tagline,
          prompt: persona.prompt,
          operator: persona.operator,
          default_voice: persona.default_voice ?? cart?.default_voice,
        }
      : { name: cartTag ?? "unknown" }
    const personaBlock = Object.fromEntries(
      Object.entries(personaRaw).filter(([_, v]) => v != null),
    )

    // Comms rules — programmatic, not inferred
    const comms =
      mode === "foreground"
        ? {
            persona: "active — follow cart persona fully",
            style: "full responses, markdown OK for terminal agents",
          }
        : {
            persona: "inactive — terse, technical, no character voice",
            style: "structured text only, concise",
            reporting:
              "when reporting results or blockers back to caller, switch to persona voice for the summary",
          }

    return JSON.stringify(
      {
        session: {
          id: context.sessionID,
          agent: context.agent,
          message_id: context.messageID,
          link: (() => {
            const domain = webDomain(self)
            if (!domain || !context.directory || !context.sessionID) return null
            const b64 = Buffer.from(context.directory).toString("base64")
            return `https://${domain}/${b64}/session/${context.sessionID}`
          })(),
        },
        mode,
        prime: {
          holder: primeHolder,
          host: primeLock?.host ?? null,
          is_self: isPrime,
        },
        persona: personaBlock,
        eems: eemsBlock(eemsRoute, eems, context),
        comms,
        host: {
          name: self,
          hostname: hostname(),
          platform: platform(),
          arch: arch(),
          hardware: hardware(),
        },
        mesh: meshTopology(),
        workspace: {
          directory: context.directory,
          worktree: context.worktree,
        },
        datetime: {
          iso: now.toISOString(),
          local: now.toLocaleString(),
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        guidance: {
          memory:
            "memory_recall(query, subject?, limit?) for semantic search. " +
            "memory_store(subject, content) to persist decisions. " +
            "memory_list() to discover categories. memory_get(ids) for full entries. " +
            "Use on demand — subject-scoped, tight limits.",
        },
      },
      null,
      2,
    )
  },
})
