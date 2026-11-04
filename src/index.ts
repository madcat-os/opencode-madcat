import { Plugin } from "@opencode/plugin"
import { z } from "zod"
import pkg from "../package.json" with { type: "json" }
import { ConfigError, loadMesh } from "./config.ts"
import { Peers, type Peer } from "./mesh.ts"
import { Mesh, type Hello } from "./rpc.ts"

export const VERSION: string = pkg.version

const HELLO_TIMEOUT = 5_000

export type HostStatus =
  | { name: string; self: boolean; url: string; directory?: string; ok: true; hello: Hello; mismatch: boolean }
  | { name: string; self: boolean; url: string; directory?: string; ok: false; error: string }

export async function probe(peer: Peer, timeout = HELLO_TIMEOUT): Promise<HostStatus> {
  const base = { name: peer.name, self: peer.self, url: peer.url, directory: peer.directory }
  try {
    const hello = await peer.rpc.hello({}, { signal: AbortSignal.timeout(timeout) })
    return { ...base, ok: true, hello, mismatch: hello.version !== VERSION }
  } catch (error) {
    return { ...base, ok: false, error: describe(error) }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    const e = error as { type?: unknown; message?: unknown }
    if (typeof e.message === "string") return typeof e.type === "string" ? `${e.type}: ${e.message}` : e.message
  }
  return String(error)
}

export function formatHosts(statuses: HostStatus[]): string {
  const lines = statuses.map((s) => {
    const tag = s.self ? " (self)" : ""
    if (!s.ok) return `✗ ${s.name}${tag}  unreachable: ${s.error}`
    const marks = [
      s.mismatch ? `version ${s.hello.version} ≠ ${VERSION}` : `v${s.hello.version}`,
      s.hello.supervisor ? `supervisor ${s.hello.supervisor.host}/${s.hello.supervisor.sessionID}` : "no supervisor",
      `${s.hello.workers} worker${s.hello.workers === 1 ? "" : "s"}`,
      s.directory ? `dir ${s.directory}` : "no default dir",
    ]
    return `${s.mismatch ? "!" : "●"} ${s.name}${tag}  ${marks.join(" · ")}`
  })
  return lines.join("\n")
}

export default Plugin.define({
  id: "madcat",
  async setup(ctx) {
    let peers: Peers
    try {
      peers = new Peers(loadMesh())
    } catch (error) {
      if (error instanceof ConfigError) {
        console.warn(`[madcat] mesh disabled: ${error.message}`)
        return
      }
      throw error
    }

    await ctx.rpc.register(Mesh, {
      async hello() {
        return { host: peers.self, version: VERSION, workers: 0 }
      },
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "mesh", description: "MADCAT mesh: hosts and sessions" })
      editor.add({
        name: "hosts",
        description:
          "List every host in the mesh with reachability, plugin version, supervisor claim and default spawn directory. Self is marked.",
        input: z.object({}),
        options: { namespace: "mesh" },
        execute: async () => {
          const statuses = await Promise.all(peers.all.map((p) => probe(p)))
          return { content: formatHosts(statuses) }
        },
      })
    })
  },
})
