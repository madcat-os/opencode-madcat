/**
 * Legacy memory — read-only bridge to the `madcat` CLI memory system (~5,500 memories).
 * Wraps `madcat memory` subcommands with --json output.
 * These are the pre-EEMS memories from the original SQLite store.
 *
 * READ-ONLY: no store, forget, or classify exposed.
 */

import { tool } from "../lib/tool"
import { execSync } from "child_process"

function madcat(subcmd: string): string {
  try {
    return execSync(`madcat memory ${subcmd} --json 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 15000,
    }).trim()
  } catch (e: any) {
    return JSON.stringify({ error: e?.message || String(e) })
  }
}

export const recall = tool({
  description:
    "Semantic recall from legacy memory store (~5,500 pre-EEMS memories). " +
    "Hybrid: embeddings + FTS. READ-ONLY. Use for deep history, comms doctrine, operator philosophy, fiction analysis.",
  args: {
    query: tool.schema.string().describe("Search query"),
    limit: tool.schema.number().optional().describe("Max results (default: 5)"),
    subject: tool.schema.string().optional().describe("Filter by subject"),
  },
  async execute(args) {
    const parts = [JSON.stringify(args.query)]
    if (args.limit) parts.push(`--limit ${args.limit}`)
    if (args.subject) parts.push(`--subject ${JSON.stringify(args.subject)}`)
    return madcat(`recall ${parts.join(" ")}`)
  },
})

export const search = tool({
  description:
    "Browse legacy memories by subject (no query needed). " +
    "Use after list to explore a specific subject category. READ-ONLY.",
  args: {
    subject: tool.schema.string().describe("Subject to browse"),
    limit: tool.schema.number().optional().describe("Max results (default: 20)"),
  },
  async execute(args) {
    const parts = [`--subject ${JSON.stringify(args.subject)}`]
    if (args.limit) parts.push(`--limit ${args.limit}`)
    return madcat(`search ${parts.join(" ")}`)
  },
})

export const list = tool({
  description:
    "List all subjects in legacy memory store with entry counts. " +
    "~5,000 subjects. Use to discover what knowledge categories exist. READ-ONLY.",
  args: {
    namespace: tool.schema.string().optional().describe("Unused, kept for compatibility"),
  },
  async execute() {
    return madcat("list")
  },
})

export const core = tool({
  description:
    "Show all core (immutable) memories from legacy store. " +
    "These are identity-grade, permanently locked entries. READ-ONLY.",
  args: {},
  async execute() {
    return madcat("core")
  },
})