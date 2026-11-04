import { OpenCode, type OpenCodeClient, type RpcClient } from "@opencode/client"
import type { HostConfig, MeshConfig } from "./config.ts"
import { Mesh as MeshRpc } from "./rpc.ts"

export interface Peer {
  readonly name: string
  readonly url: string
  readonly directory?: string
  readonly self: boolean
  readonly client: OpenCodeClient
  readonly rpc: RpcClient<typeof MeshRpc>
}

export class Peers {
  readonly self: string
  readonly all: readonly Peer[]
  private readonly byName: Map<string, Peer>

  constructor(config: MeshConfig) {
    this.self = config.self
    this.all = config.hosts.map((host) => peer(host, host.name === config.self))
    this.byName = new Map(this.all.map((p) => [p.name, p]))
  }

  get(name: string): Peer | undefined {
    return this.byName.get(name)
  }

  get me(): Peer {
    const me = this.byName.get(this.self)
    if (!me) throw new Error(`no peer entry for self (${this.self})`)
    return me
  }

  get others(): Peer[] {
    return this.all.filter((p) => !p.self)
  }
}

function peer(host: HostConfig, self: boolean): Peer {
  const token = Buffer.from(`${host.username}:${host.password}`).toString("base64")
  const client = OpenCode.make({
    baseUrl: host.url,
    headers: { authorization: `Basic ${token}` },
  })
  return {
    name: host.name,
    url: host.url,
    directory: host.directory,
    self,
    client,
    rpc: client.rpc(MeshRpc),
  }
}
