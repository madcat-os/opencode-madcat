/**
 * SDK smoketest — single tool that exercises @opencode/client against a mesh
 * host to confirm the V2 client works in opencode's Bun runtime.
 *
 * Tests: server.info → location.get → session.list
 * Returns stringified result (p.split safe).
 */

import { tool } from "../lib/tool"
import { sdk } from "../lib/sdk.ts"
import { hostDescription } from "../lib/config.ts"

export const sdk_check = tool({
  description: "Smoketest: verify @opencode/client works against a mesh host. Calls server.info, location.get, and session.list.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
  },
  async execute(args) {
    try {
      const client = sdk(args.host)
      const info = await client.server.info()
      const location = await client.location.get()
      const sessions = await client.session.list({ limit: 3 })
      return JSON.stringify(
        {
          status: "ok",
          sdk: "@opencode/client",
          host: args.host,
          version: info.version,
          location,
          sessionCount: sessions.data.length,
          sample: sessions.data.map((s) => ({ id: s.id, title: s.title || "(untitled)" })),
        },
        null,
        2,
      )
    } catch (e: any) {
      return JSON.stringify(
        {
          status: "error",
          sdk: "@opencode/client",
          host: args.host,
          error: e?.message || String(e),
          stack: e?.stack?.split("\n").slice(0, 5),
        },
        null,
        2,
      )
    }
  },
})
