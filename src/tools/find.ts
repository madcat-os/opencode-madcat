/**
 * Find tools — file search via the opencode API, text search over SSH.
 *
 * V2 exposes only filesystem find (`/api/fs/find`); the V1 text and symbol
 * search endpoints are gone. `text` shells out to ripgrep on the target host.
 */

import { tool } from "../lib/tool"
import { execSync } from "child_process"
import { sdk, run } from "../lib/sdk.ts"
import { meshHost, hostDescription } from "../lib/config.ts"

export const text = tool({
  description: "Search for text patterns in a directory on the host with ripgrep. Returns file paths, line numbers, and matches.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    pattern: tool.schema.string().describe("Search pattern (regex)"),
    directory: tool.schema.string().optional().describe("Directory to search (defaults to the serve's location)"),
    limit: tool.schema.number().optional().describe("Max matching lines (default: 100)"),
  },
  async execute(args) {
    return run(async () => {
      const directory = args.directory ?? (await sdk(args.host).location.get()).directory
      const limit = args.limit ?? 100
      const pat = JSON.stringify(args.pattern)
      const dir = JSON.stringify(directory)
      const rg =
        `if command -v rg >/dev/null 2>&1; then rg -n --no-heading --color never -m ${limit} -e ${pat} ${dir}; ` +
        `else grep -rnIE --exclude-dir=.git --exclude-dir=node_modules -e ${pat} ${dir}; fi | head -n ${limit}`
      let isLocal = false
      try {
        const url = meshHost(args.host).url
        isLocal = url.includes("localhost") || url.includes("127.0.0.1")
      } catch { isLocal = false }
      const cmd = isLocal ? rg : `ssh ${args.host} ${JSON.stringify(rg)}`
      let out = ""
      try {
        out = execSync(cmd, { encoding: "utf-8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
      } catch (e: any) {
        // rg exits 1 on no matches
        out = e?.stdout ?? ""
      }
      return out
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const m = line.match(/^(.*?):(\d+):(.*)$/)
          return m ? { path: m[1], line: Number(m[2]), text: m[3] } : { text: line }
        })
    })
  },
})

export const files = tool({
  description: "Find files and directories by name (fuzzy match) in a project on the host.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    query: tool.schema.string().describe("Filename search query"),
    limit: tool.schema.number().optional().describe("Max results (1-200)"),
    type: tool.schema.enum(["file", "directory"]).optional().describe("Limit to files or directories"),
    directory: tool.schema.string().optional().describe("Project directory on the host (defaults to the serve's location)"),
  },
  async execute(args) {
    return run(async () =>
      (
        await sdk(args.host).file.find({
          location: args.directory ? { directory: args.directory } : undefined,
          query: args.query,
          limit: args.limit,
          type: args.type,
        })
      ).data,
    )
  },
})
