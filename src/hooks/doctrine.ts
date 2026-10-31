/**
 * experimental.chat.system.transform hook — doctrine injection.
 *
 * Looks up the session's agent name and pushes any doctrine blocks whose
 * `applies_to` matches that agent into output.system.
 *
 * Doctrine source: markdown files under src/doctrines/ in this plugin repo.
 * Load is cached at first call.
 */

import { doctrinesFor } from "../lib/doctrines"

/** Minimal shape of the v2 `session.hook("context", ...)` event we touch. */
type ContextEvent = {
  readonly sessionID: string
  readonly agent: string
  system: Array<{ type: "text"; text: string } | Record<string, unknown>>
}

export const doctrine =
  () =>
  async (event: ContextEvent): Promise<void> => {
    try {
      // v2 `context` event carries the agent directly — no session lookup needed.
      const agentName: string = event.agent ?? ""
      if (!agentName) return

      const matched = doctrinesFor(agentName)
      for (const d of matched) {
        event.system.push({ type: "text", text: d.content })
      }
    } catch {
      // Swallow errors — doctrine injection failure should never crash the plugin
    }
  }
