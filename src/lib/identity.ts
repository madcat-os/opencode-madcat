/**
 * identity — caller context for cross-session dispatch.
 *
 * Uses the opencode plugin tool context (sessionID, agent, etc.)
 * passed as the second argument to tool execute().
 */

import { hostname } from "node:os"
import { meshHosts } from "./config.ts"

/** The context opencode passes to every tool execute(args, context). */
export interface ToolContext {
  sessionID: string
  agent: string
  messageID: string
  directory: string
  worktree: string
  /** Abort signal for the running tool call. */
  abort?: AbortSignal
}

/**
 * Resolve our own mesh name from config.toml.
 * Finds the [mesh.*] entry whose URL points to localhost.
 * Falls back to OS hostname if no match.
 */
function selfMeshName(): string {
  try {
    const hosts = meshHosts()
    for (const [name, entry] of Object.entries(hosts)) {
      if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(entry.url)) return name
    }
  } catch { /* config not loaded — fall through */ }
  return hostname()
}

/**
 * Build a context header to prepend to prompts sent to other sessions.
 * Tells the target agent who started it and how to report back.
 */
export function buildCallerHeader(ctx: ToolContext, _targetHost: string): string {
  const self = selfMeshName()
  return [
    `<caller>`,
    `  session: ${ctx.sessionID}`,
    `  host: ${self}`,
    `  agent: ${ctx.agent}`,
    `</caller>`,
    `<dispatch>`,
    `  You were started by the session above.`,
    `  When you finish or hit a blocking problem, send an async prompt back:`,
    `    tool: messages_prompt_async`,
    `    host: ${self}`,
    `    id: ${ctx.sessionID}`,
    `  Include a concise summary of results or the blocker.`,
    `  Do NOT wait for acknowledgment — fire and continue or exit.`,
    `</dispatch>`,
    ``,
  ].join("\n")
}
