/**
 * Infrastructure tools — MCP server management, skills, references.
 *
 * V1 formatter/LSP status endpoints no longer exist in V2 (V2 does not run
 * language servers); those tools were dropped.
 */

import { tool } from "../lib/tool"
import { sdk, run } from "../lib/sdk.ts"
import { hostDescription } from "../lib/config.ts"

const loc = (directory?: string) => (directory ? { location: { directory } } : undefined)
const dirArg = () => tool.schema.string().optional().describe("Project directory on the host (defaults to the serve's location)")

export const mcp = tool({
  description: "Get status of all MCP (Model Context Protocol) servers — connected, pending, disabled, failed, needs-auth.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    directory: dirArg(),
  },
  async execute(args) {
    return run(async () => (await sdk(args.host).mcp.list(loc(args.directory))).data)
  },
})

export const mcp_add = tool({
  description: "Add an MCP server dynamically without editing config. Give either a local command or a remote URL.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    name: tool.schema.string().describe("MCP server name"),
    command: tool.schema.array(tool.schema.string()).optional().describe("Local server command and arguments, e.g. [\"npx\", \"@playwright/mcp\"]"),
    url: tool.schema.string().optional().describe("Remote server URL"),
    headers: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe("Headers for a remote server"),
    directory: dirArg(),
  },
  async execute(args) {
    return run(async () => {
      if (!args.command && !args.url) throw new Error("provide either command (local) or url (remote)")
      const config = args.command
        ? { type: "local" as const, command: args.command }
        : { type: "remote" as const, url: args.url!, headers: args.headers }
      await sdk(args.host).mcp.add({ ...loc(args.directory), server: args.name, config })
      return { status: "added", name: args.name, config }
    })
  },
})

export const mcp_remove = tool({
  description: "Remove a dynamically added MCP server by name.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    name: tool.schema.string().describe("MCP server name"),
    directory: dirArg(),
  },
  async execute(args) {
    return run(async () => {
      await sdk(args.host).mcp.remove({ ...loc(args.directory), server: args.name })
      return { status: "removed", name: args.name }
    })
  },
})

export const mcp_connect = tool({
  description: "Connect (start) a configured MCP server by name.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    name: tool.schema.string().describe("MCP server name"),
    directory: dirArg(),
  },
  async execute(args) {
    return run(async () => {
      await sdk(args.host).mcp.connect({ ...loc(args.directory), server: args.name })
      return { status: "connected", name: args.name }
    })
  },
})

export const mcp_disconnect = tool({
  description: "Disconnect (stop) a running MCP server by name.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    name: tool.schema.string().describe("MCP server name"),
    directory: dirArg(),
  },
  async execute(args) {
    return run(async () => {
      await sdk(args.host).mcp.disconnect({ ...loc(args.directory), server: args.name })
      return { status: "disconnected", name: args.name }
    })
  },
})

export const skills = tool({
  description: "List the skills available on the host for a project.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    directory: dirArg(),
  },
  async execute(args) {
    return run(async () => (await sdk(args.host).skill.list(loc(args.directory))).data)
  },
})
