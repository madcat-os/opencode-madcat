/**
 * Shared client factory — resolves host from ~/.config/madcat/config.toml [mesh],
 * creates an authenticated V2 OpenCode client per request.
 *
 * V2 client methods return the decoded body directly and throw on error, so
 * there is no `unwrap()` step. `run()` wraps a call into a JSON string result.
 */

import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { meshHost } from "./config.ts"

export type { OpenCodeClient }

export function sdk(host: string): OpenCodeClient {
  const h = meshHost(host)
  // Mesh entries may carry a trailing /api from the V1 era — the V2 client adds it itself.
  const baseUrl = h.url.replace(/\/api\/?$/, "").replace(/\/$/, "")
  const credentials = btoa(`${h.username ?? "opencode"}:${h.password ?? ""}`)
  return OpenCode.make({
    baseUrl,
    headers: { Authorization: `Basic ${credentials}` },
  })
}

/** Resolve the project ID for a directory on a host (defaults to the serve's own location). */
export async function projectId(host: string, directory?: string): Promise<string> {
  const loc = await sdk(host).location.get(directory ? { location: { directory } } : undefined)
  return loc.project.id
}

/** Safe execute wrapper: calls fn, returns JSON string (p.split safe). */
export async function run<T>(fn: () => Promise<T>): Promise<string> {
  try {
    const data = await fn()
    return JSON.stringify(data, null, 2)
  } catch (e: any) {
    return JSON.stringify({ error: e?.message || String(e) }, null, 2)
  }
}
