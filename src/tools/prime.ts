/**
 * prime — PRIME session lock management (global, Postgres-backed).
 *
 * The PRIME lock marks the one session mesh-wide that owns the operator
 * channel. Only one session should be PRIME.
 *
 * Stored in the `locks` table in EEMS Postgres — shared across all hosts.
 * The lock record includes session ID, host, agent, persona, mesh URL,
 * and hardware info so other consumers can route to the correct host.
 */

import { tool } from "../lib/tool"
import { hostname, platform, arch } from "node:os"
import { acquireLock, readLock, releaseLock } from "../lib/db.ts"
import { meshHosts } from "../lib/config.ts"
import type { ToolContext } from "../lib/identity"

const LOCK_NAME = "prime"

/** Resolve mesh name + URL for this host. */
function selfMesh(): { name: string; url: string } {
  try {
    const hosts = meshHosts()
    for (const [name, entry] of Object.entries(hosts)) {
      if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(entry.url)) {
        return { name, url: entry.url }
      }
    }
  } catch {}
  return { name: hostname(), url: "" }
}

/** Read active cart tag from the persona state file. */
function activeCartTag(): string | null {
  try {
    const { readFileSync } = require("node:fs")
    const { join } = require("node:path")
    const { homedir } = require("node:os")
    const { parse } = require("smol-toml")
    const path = join(homedir(), ".local", "share", "madcat", "tts-state.toml")
    const state = parse(readFileSync(path, "utf-8"))
    return (state as any).active_cart ?? null
  } catch {
    return null
  }
}

export const claim = tool({
  description:
    "Claim the PRIME session lock. Makes the current session (or a specified session) the exclusive " +
    "owner of the operator channel. Overwrites any existing lock.",
  args: {
    session_id: tool.schema
      .string()
      .optional()
      .describe("Session ID to lock as PRIME. Omit to use the current session."),
  },
  async execute(args: { session_id?: string }, context: ToolContext) {
    const id = args.session_id ?? context.sessionID
    if (!id) return JSON.stringify({ error: "No session ID available" })

    const mesh = selfMesh()
    const previous = await readLock(LOCK_NAME)

    const row = await acquireLock(LOCK_NAME, {
      session_id: id,
      host: mesh.name,
      hostname: hostname(),
      agent: context.agent ?? undefined,
      persona: activeCartTag() ?? undefined,
      platform: platform(),
      arch: arch(),
      mesh_url: mesh.url,
    })

    return JSON.stringify({
      status: "claimed",
      session: id,
      host: mesh.name,
      mesh_url: mesh.url,
      previous: previous
        ? { session: previous.session_id, host: previous.host }
        : null,
    })
  },
})

export const release = tool({
  description:
    "Release the PRIME session lock. Removes the lock so no session is PRIME.",
  args: {},
  async execute() {
    const previous = await releaseLock(LOCK_NAME)
    return JSON.stringify({
      status: "released",
      previous: previous
        ? { session: previous.session_id, host: previous.host }
        : null,
    })
  },
})

export const status = tool({
  description:
    "Check the current PRIME session lock status. Returns the locked session ID, host, " +
    "agent, persona, and mesh URL — or null if unlocked.",
  args: {},
  async execute(_args: {}, context: ToolContext) {
    const lock = await readLock(LOCK_NAME)
    if (!lock) {
      return JSON.stringify({ locked: false, session: null })
    }
    return JSON.stringify({
      locked: true,
      session: lock.session_id,
      host: lock.host,
      hostname: lock.hostname,
      agent: lock.agent,
      persona: lock.persona,
      mesh_url: lock.mesh_url,
      claimed_at: lock.claimed_at,
      is_self: lock.session_id === context.sessionID,
    })
  },
})
