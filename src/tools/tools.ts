/**
 * Tool introspection — list IDs and schemas.
 *
 * V2 has no HTTP endpoint for the tool registry, so these read the local
 * plugin context (`ctx.tool.list()`) — the host this plugin runs on.
 */

import { tool } from "../lib/tool"
import { run } from "../lib/sdk.ts"

type ToolLister = () => Promise<readonly { id: string; description?: string; input?: unknown; options?: unknown }[]>

let lister: ToolLister | null = null

/** Wired from index.ts at plugin setup with `ctx.tool.list`. */
export function bindToolLister(fn: ToolLister): void {
  lister = fn
}

export const ids = tool({
  description: "List all tool IDs registered on this host (built-in + plugin + MCP). Use to discover what tools are available.",
  args: {
    prefix: tool.schema.string().optional().describe("Only IDs starting with this prefix (e.g. memory_, sessions_)"),
  },
  async execute(args) {
    return run(async () => {
      if (!lister) throw new Error("tool registry not available")
      const all = (await lister()).map((t) => t.id).sort()
      return args.prefix ? all.filter((id) => id.startsWith(args.prefix!)) : all
    })
  },
})

export const schemas = tool({
  description: "Get description and input schema for tools registered on this host.",
  args: {
    id: tool.schema.string().optional().describe("Single tool ID; omit for all"),
    prefix: tool.schema.string().optional().describe("Only tools whose ID starts with this prefix"),
  },
  async execute(args) {
    return run(async () => {
      if (!lister) throw new Error("tool registry not available")
      let all = await lister()
      if (args.id) all = all.filter((t) => t.id === args.id)
      if (args.prefix) all = all.filter((t) => t.id.startsWith(args.prefix!))
      return all.map((t) => ({ id: t.id, description: t.description, input: toJsonSchema(t.input), options: t.options }))
    })
  },
})

function toJsonSchema(input: unknown): unknown {
  if (!input || typeof input !== "object") return input
  const anyInput = input as any
  // Zod object (our own tools) → JSON schema; plain JSON schema passes through.
  if (typeof anyInput.toJSONSchema === "function") return anyInput.toJSONSchema()
  if (anyInput["~standard"] && typeof anyInput.shape === "object") {
    try {
      const { z } = require("zod")
      return z.toJSONSchema(anyInput)
    } catch {
      return "(zod schema)"
    }
  }
  return input
}
