import type { Plugin } from "@opencode/plugin"
import type { Peers } from "./mesh.ts"
import type { ClaimOutput, SupervisorRef } from "./rpc.ts"
import type { State } from "./state.ts"

const CLAIM_TIMEOUT = 5_000

export interface ClaimOptions {
  force?: boolean
}

export type ClaimResult =
  | { ok: true; ref: SupervisorRef; unreachable: string[] }
  | { ok: false; reason: "local-held" | "remote-held"; held: SupervisorRef; on: string }

export type PeerClaimOutcome =
  { peer: string; ok: true; result: ClaimOutput } | { peer: string; ok: false; error: string }

export class Supervisor {
  constructor(
    private readonly ctx: Plugin.Context,
    private readonly peers: Peers,
    private readonly state: State,
  ) {}

  async current(): Promise<SupervisorRef | undefined> {
    return this.state.supervisor()
  }

  async isSupervisor(sessionID: string): Promise<boolean> {
    const ref = await this.state.supervisor()
    return ref?.host === this.peers.self && ref.sessionID === sessionID
  }

  async claim(sessionID: string, options: ClaimOptions = {}): Promise<ClaimResult> {
    const ref: SupervisorRef = { host: this.peers.self, sessionID, claimedAt: Date.now() }
    const local = await this.state.supervisor()
    if (local && !options.force && !same(local, ref)) {
      return { ok: false, reason: "local-held", held: local, on: this.peers.self }
    }

    const outcomes = await this.broadcast({ ...ref, force: options.force })
    const held = outcomes.find((o) => o.ok && !o.result.ok && o.result.held)
    if (held && held.ok && held.result.held) {
      return { ok: false, reason: "remote-held", held: held.result.held, on: held.peer }
    }

    await this.applyLocal(ref, options.force ?? false)
    return { ok: true, ref, unreachable: outcomes.filter((o) => !o.ok).map((o) => o.peer) }
  }

  async release(
    sessionID: string,
  ): Promise<{ ok: true; interrupted: number; unreachable: string[] } | { ok: false; held?: SupervisorRef }> {
    const local = await this.state.supervisor()
    if (!local || local.host !== this.peers.self || local.sessionID !== sessionID) {
      return { ok: false, held: local }
    }

    let interrupted = 0
    for (const entry of await this.state.roster()) {
      const peer = this.peers.get(entry.host)
      if (!peer) continue
      try {
        await peer.client.session.interrupt(
          { sessionID: entry.sessionID, resume: false },
          { signal: AbortSignal.timeout(CLAIM_TIMEOUT) },
        )
        interrupted++
      } catch {}
    }

    const outcomes = await this.broadcast({ ...local, release: true })
    await this.state.setSupervisor(undefined)
    await this.ctx.session.instructions.entry.remove({ sessionID, key: "mesh.identity" }).catch(() => {})
    return { ok: true, interrupted, unreachable: outcomes.filter((o) => !o.ok).map((o) => o.peer) }
  }

  async handleClaim(input: SupervisorRef & { force?: boolean; release?: boolean }): Promise<ClaimOutput> {
    const local = await this.state.supervisor()
    if (input.release) {
      if (local && same(local, input)) await this.state.setSupervisor(undefined)
      return { ok: true }
    }
    if (local && !same(local, input) && !input.force) {
      return { ok: false, held: local }
    }
    await this.applyLocal(
      { host: input.host, sessionID: input.sessionID, claimedAt: input.claimedAt },
      input.force ?? false,
    )
    return { ok: true }
  }

  async status(): Promise<
    Array<
      | { peer: string; self: boolean; ok: true; supervisor?: SupervisorRef }
      | { peer: string; self: boolean; ok: false; error: string }
    >
  > {
    return Promise.all(
      this.peers.all.map(async (peer) => {
        try {
          const hello = await peer.rpc.hello({}, { signal: AbortSignal.timeout(CLAIM_TIMEOUT) })
          return { peer: peer.name, self: peer.self, ok: true as const, supervisor: hello.supervisor }
        } catch (error) {
          return { peer: peer.name, self: peer.self, ok: false as const, error: describe(error) }
        }
      }),
    )
  }

  private async broadcast(input: SupervisorRef & { force?: boolean; release?: boolean }): Promise<PeerClaimOutcome[]> {
    return Promise.all(
      this.peers.others.map(async (peer) => {
        try {
          const result = await peer.rpc.claim(input, { signal: AbortSignal.timeout(CLAIM_TIMEOUT) })
          return { peer: peer.name, ok: true as const, result }
        } catch (error) {
          return { peer: peer.name, ok: false as const, error: describe(error) }
        }
      }),
    )
  }

  private async applyLocal(ref: SupervisorRef, forced: boolean): Promise<void> {
    const previous = await this.state.supervisor()
    await this.state.setSupervisor(ref)
    if (forced && previous && previous.host === this.peers.self && !same(previous, ref)) {
      await this.ctx.session
        .synthetic({
          sessionID: previous.sessionID,
          text: `[mesh] supervisor claim taken by ${ref.host}/${ref.sessionID}. This session is no longer the supervisor.`,
        })
        .catch(() => {})
      await this.ctx.session.instructions.entry
        .remove({ sessionID: previous.sessionID, key: "mesh.identity" })
        .catch(() => {})
    }
  }
}

export function same(
  a: Pick<SupervisorRef, "host" | "sessionID">,
  b: Pick<SupervisorRef, "host" | "sessionID">,
): boolean {
  return a.host === b.host && a.sessionID === b.sessionID
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    const e = error as { type?: unknown; message?: unknown }
    if (typeof e.message === "string") return typeof e.type === "string" ? `${e.type}: ${e.message}` : e.message
  }
  return String(error)
}
