/**
 * File tools — list, read, status via opencode API.
 * list falls back to SSH ls when the API returns empty (out-of-project paths).
 */

import { tool } from "../lib/tool"
import { execSync } from "child_process"
import { sdk, run } from "../lib/sdk.ts"
import { meshHost, hostDescription } from "../lib/config.ts"

const loc = (directory?: string) => (directory ? { location: { directory } } : undefined)

export const list = tool({
  description: "List files and directories at a given path via the API.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    path: tool.schema.string().describe("Directory path to list (relative to the project, or absolute)"),
    directory: tool.schema.string().optional().describe("Project directory on the host (defaults to the serve's location)"),
  },
  async execute(args) {
    return run(async () => {
      // Try the API first
      const result = await sdk(args.host).file.list({ ...loc(args.directory), path: args.path })
      if (result.data.length > 0) return result.data

      // API returned empty — fall back to ls via SSH (or local)
      // Detect local: check if config.toml mesh URL for this host points to localhost
      let isLocal = false
      try {
        const hostUrl = meshHost(args.host).url
        isLocal = hostUrl.includes("localhost") || hostUrl.includes("127.0.0.1")
      } catch { isLocal = false }
      const lsCmd = `ls -1pa ${JSON.stringify(args.path)} 2>/dev/null`
      const cmd = isLocal ? lsCmd : `ssh ${args.host} ${JSON.stringify(lsCmd)}`
      const output = execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim()
      if (!output) return []
      return output.split("\n").map((entry: string) => {
        const isDir = entry.endsWith("/")
        const name = isDir ? entry.slice(0, -1) : entry
        return {
          name,
          path: name,
          absolute: args.path.replace(/\/$/, "") + "/" + name,
          type: isDir ? "directory" : "file",
        }
      })
    })
  },
})

export const read = tool({
  description: "Read a file's contents via the opencode API.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    path: tool.schema.string().describe("File path to read (relative to the project, or absolute)"),
    directory: tool.schema.string().optional().describe("Project directory on the host (defaults to the serve's location)"),
  },
  async execute(args) {
    try {
      const bytes = await sdk(args.host).file.read({ ...loc(args.directory), path: args.path })
      return new TextDecoder().decode(bytes)
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || String(e) }, null, 2)
    }
  },
})

export const status = tool({
  description: "Get VCS status of tracked files (modified, staged, untracked).",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    directory: tool.schema.string().optional().describe("Project directory on the host (defaults to the serve's location)"),
  },
  async execute(args) {
    return run(async () => (await sdk(args.host).vcs.status(loc(args.directory))).data)
  },
})
