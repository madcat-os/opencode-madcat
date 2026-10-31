/**
 * session.idle handler — fires when any session goes idle.
 *
 * V1 sent a TUI toast. The v2 plugin context has no TUI surface, so this now
 * emits a structured log line (captured by the opencode runtime) with the
 * session title. Best-effort: lookup failure never crashes the plugin.
 */

import { Plugin } from "@opencode/plugin"

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

/** Minimal shape of the v2 `session.idle` event. */
type IdleEvent = { type: string; data?: { sessionID?: string } }

export const idle =
  (ctx: Context) =>
  async (event: IdleEvent): Promise<void> => {
    const sessionID = event?.data?.sessionID
    if (!sessionID) return

    try {
      const session = (await ctx.session.get({ sessionID })) as any
      const title = session?.title ?? sessionID
      console.log(`[idle] session complete: ${title} (${sessionID})`)
    } catch {
      // Swallow errors — notification failure should never crash the plugin
    }
  }
