import type { Peers } from "./mesh.ts"
import type { Delivery, MeshAddress, MessageKind, SupervisorRef } from "./rpc.ts"
import { describe } from "./supervisor.ts"

const TIMEOUT = 10_000
const WAIT_TIMEOUT = 30 * 60_000

export interface Target {
  host: string
  sessionID: string
}

export interface SpawnInput {
  host: string
  name: string
  directory: string
  orders: string
  prompt?: string
  title?: string
}

export class SteerError extends Error {
  override name = "SteerError"
}

/** Thin dispatch over the session API + mesh RPC of whichever host owns the target. Roster writes live in index.ts. */
export class Steer {
  constructor(private readonly peers: Peers) {}

  private peer(host: string) {
    const peer = this.peers.get(host)
    if (!peer) throw new SteerError(`unknown host "${host}" (known: ${this.peers.all.map((p) => p.name).join(", ")})`)
    return peer
  }

  async spawn(supervisor: SupervisorRef, input: SpawnInput): Promise<Target> {
    const peer = this.peer(input.host)
    const session = await peer.client.session.create(
      { agent: "worker", title: input.title ?? `mesh: ${input.name}`, location: { directory: input.directory } },
      { signal: AbortSignal.timeout(TIMEOUT) },
    )
    const target = { host: input.host, sessionID: session.id }
    try {
      await peer.rpc.register(
        { sessionID: session.id, name: input.name, directory: input.directory, supervisor },
        { signal: AbortSignal.timeout(TIMEOUT) },
      )
    } catch (error) {
      await peer.client.session.remove({ sessionID: session.id }).catch(() => {})
      throw new SteerError(`register on ${input.host} failed: ${describe(error)}`)
    }
    try {
      await this.orders(target, input.orders)
    } catch (error) {
      await peer.rpc.unregister({ sessionID: session.id }).catch(() => {})
      await peer.client.session.remove({ sessionID: session.id }).catch(() => {})
      throw new SteerError(`setting orders on ${input.host} failed: ${describe(error)}`)
    }
    if (input.prompt) {
      await this.send(target, {
        from: supervisorAddress(supervisor),
        kind: "order",
        body: input.prompt,
        delivery: "queue",
      })
    }
    return target
  }

  async send(
    target: Target,
    message: { from: MeshAddress; kind: MessageKind; body: string; delivery: Delivery; msgID?: string },
  ): Promise<string> {
    const peer = this.peer(target.host)
    const msgID = message.msgID ?? messageID()
    await peer.rpc.deliver(
      {
        to: target.sessionID,
        from: message.from,
        msgID,
        kind: message.kind,
        body: message.body,
        delivery: message.delivery,
      },
      { signal: AbortSignal.timeout(TIMEOUT) },
    )
    return msgID
  }

  async note(target: Target, text: string): Promise<void> {
    await this.peer(target.host).client.session.synthetic(
      { sessionID: target.sessionID, text },
      { signal: AbortSignal.timeout(TIMEOUT) },
    )
  }

  async orders(target: Target, value: string | undefined): Promise<void> {
    const api = this.peer(target.host).client.session.instructions.entry
    if (value === undefined) {
      await api.remove({ sessionID: target.sessionID, key: "mesh.orders" }, { signal: AbortSignal.timeout(TIMEOUT) })
    } else {
      await api.put(
        { sessionID: target.sessionID, key: "mesh.orders", value },
        { signal: AbortSignal.timeout(TIMEOUT) },
      )
    }
  }

  async interrupt(target: Target, resume: boolean): Promise<boolean> {
    const result = await this.peer(target.host).client.session.interrupt(
      { sessionID: target.sessionID, resume },
      { signal: AbortSignal.timeout(TIMEOUT) },
    )
    return result.interrupted
  }

  async wait(target: Target, timeout = WAIT_TIMEOUT): Promise<void> {
    await this.peer(target.host).client.session.wait(
      { sessionID: target.sessionID },
      { signal: AbortSignal.timeout(timeout) },
    )
  }

  async read(target: Target, tail: number): Promise<string> {
    const messages = await this.peer(target.host).client.session.context(
      { sessionID: target.sessionID },
      { signal: AbortSignal.timeout(TIMEOUT) },
    )
    const lines: string[] = []
    for (const m of messages) {
      if (m.type === "user") lines.push(`[user] ${m.text}`)
      else if (m.type === "synthetic") lines.push(`[synthetic] ${m.text}`)
      else if (m.type === "assistant") {
        for (const part of m.content) {
          if (part.type === "text") lines.push(`[assistant] ${part.text}`)
          else if (part.type === "tool") lines.push(`[tool ${part.name} ${part.state.status}] ${summarize(part.state)}`)
        }
      }
    }
    const slice = tail > 0 ? lines.slice(-tail) : lines
    return slice.length ? slice.join("\n") : "(empty transcript)"
  }

  async remove(target: Target): Promise<void> {
    const peer = this.peer(target.host)
    await peer.rpc.unregister({ sessionID: target.sessionID }, { signal: AbortSignal.timeout(TIMEOUT) }).catch(() => {})
    await peer.client.session
      .remove({ sessionID: target.sessionID }, { signal: AbortSignal.timeout(TIMEOUT) })
      .catch(() => {})
  }
}

/** Session message ids must start with `msg_`; time-prefixed so they sort by creation. */
export function messageID(now = Date.now()): string {
  const rand = crypto.randomUUID().replaceAll("-", "").slice(0, 16)
  return `msg_${now.toString(16).padStart(12, "0")}${rand}`
}

export function supervisorAddress(ref: SupervisorRef): MeshAddress {
  return { host: ref.host, sessionID: ref.sessionID, name: "super" }
}

function summarize(state: { status: string; input?: unknown }): string {
  const input = "input" in state && state.input !== undefined ? JSON.stringify(state.input) : ""
  return input.length > 200 ? `${input.slice(0, 200)}…` : input
}
