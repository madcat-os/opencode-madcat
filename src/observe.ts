import type { Plugin } from "@opencode/plugin"
import type { Peers } from "./mesh.ts"
import type { SupervisorRef, WorkerState } from "./rpc.ts"
import type { State } from "./state.ts"
import { describe } from "./supervisor.ts"

const TIMEOUT = 5_000
const NOTIFY_RETRIES = [1_000, 4_000, 15_000]
const PING_INTERVAL = 30_000
const PING_FAILURES = 3

export const WATCHED = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.deleted",
] as const

export type WatchedType = (typeof WATCHED)[number]

export type Transition = { state: WorkerState; removed?: boolean }

export type RosterUpdate = { name?: string; directory?: string; state?: WorkerState; removed?: boolean }

/** Maps a session event to the worker state it implies. Pure; `undefined` means "no change". */
export function transition(type: string): Transition | undefined {
  switch (type) {
    case "session.execution.started":
      return { state: "busy" }
    case "session.execution.succeeded":
    case "session.execution.interrupted":
      return { state: "idle" }
    case "session.execution.failed":
      return { state: "error" }
    case "session.deleted":
      return { state: "done", removed: true }
    default:
      return undefined
  }
}

export interface ObserverOptions {
  pingInterval?: number
  pingFailures?: number
  retries?: number[]
}

/**
 * Worker side: watches local sessions and pushes state to the supervisor's host.
 * Supervisor side: pings hosts that have roster entries and marks them `lost`.
 */
export class Observer {
  private readonly controller = new AbortController()
  private readonly failures = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly opts: Required<ObserverOptions>

  constructor(
    private readonly ctx: Plugin.Context,
    private readonly peers: Peers,
    private readonly state: State,
    private readonly onRoster: (host: string, sessionID: string, update: RosterUpdate) => Promise<unknown>,
    options: ObserverOptions = {},
  ) {
    this.opts = {
      pingInterval: options.pingInterval ?? PING_INTERVAL,
      pingFailures: options.pingFailures ?? PING_FAILURES,
      retries: options.retries ?? NOTIFY_RETRIES,
    }
  }

  start(): void {
    void this.loop()
    this.timer = setInterval(() => void this.ping(), this.opts.pingInterval)
  }

  stop(): void {
    this.controller.abort()
    if (this.timer) clearInterval(this.timer)
  }

  private async loop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      try {
        for await (const event of this.ctx.event.subscribe({ types: [...WATCHED], signal: this.controller.signal })) {
          const next = transition(event.type)
          if (!next) continue
          const sessionID = (event.data as { sessionID?: string }).sessionID
          if (!sessionID) continue
          void this.observed(sessionID, next, event.created).catch((e) =>
            console.warn(`[madcat] observe: ${describe(e)}`),
          )
        }
      } catch (error) {
        if (this.controller.signal.aborted) return
        console.warn(`[madcat] event stream dropped (${describe(error)}); resubscribing`)
        await sleep(1_000, this.controller.signal)
      }
    }
  }

  private async observed(sessionID: string, next: Transition, at: number): Promise<void> {
    const worker = await this.state.worker(sessionID)
    if (!worker) return
    if (next.removed) await this.state.removeWorker(sessionID)
    await this.notify(worker.supervisor, {
      host: this.peers.self,
      sessionID,
      state: next.state,
      at,
      ...(next.removed ? { removed: true } : {}),
    })
  }

  /** Push one state change to the supervisor's host; local supervisor goes through the same RPC. */
  async notify(
    supervisor: SupervisorRef,
    input: { host: string; sessionID: string; state: WorkerState; at: number; removed?: boolean },
  ): Promise<boolean> {
    const peer = this.peers.get(supervisor.host)
    if (!peer) return false
    const attempts = [0, ...this.opts.retries]
    for (let i = 0; i < attempts.length; i++) {
      if (attempts[i]) await sleep(attempts[i]!, this.controller.signal)
      if (this.controller.signal.aborted) return false
      try {
        await peer.rpc.notify(input, { signal: AbortSignal.timeout(TIMEOUT) })
        return true
      } catch (error) {
        if (i === attempts.length - 1)
          console.warn(
            `[madcat] notify ${supervisor.host} failed after ${attempts.length} attempts: ${describe(error)}`,
          )
      }
    }
    return false
  }

  /** Supervisor host only: hello() every host with roster entries; mark `lost` after repeated failures. */
  async ping(): Promise<void> {
    const me = await this.state.supervisor()
    if (!me || me.host !== this.peers.self) return
    const roster = await this.state.roster()
    const hosts = new Set(roster.map((e) => e.host))
    for (const host of hosts) {
      const peer = this.peers.get(host)
      if (!peer) continue
      let ok = false
      try {
        await peer.rpc.hello({}, { signal: AbortSignal.timeout(TIMEOUT) })
        ok = true
      } catch {}
      if (ok) {
        if (this.failures.get(host)) {
          this.failures.delete(host)
          await this.reconcile(me, host)
        }
        continue
      }
      const n = (this.failures.get(host) ?? 0) + 1
      this.failures.set(host, n)
      if (n < this.opts.pingFailures) continue
      for (const e of roster) {
        if (e.host === host && e.state !== "lost") await this.onRoster(host, e.sessionID, { state: "lost" })
      }
    }
  }

  /** Pull one host's live worker list and fold it into the roster. */
  async reconcile(me: SupervisorRef, host: string): Promise<void> {
    const peer = this.peers.get(host)
    if (!peer) return
    let workers
    try {
      workers = (await peer.rpc.list({}, { signal: AbortSignal.timeout(TIMEOUT) })).workers
    } catch {
      for (const e of await this.state.roster()) {
        if (e.host === host && e.state !== "lost") await this.onRoster(host, e.sessionID, { state: "lost" })
      }
      return
    }
    const mine = workers.filter((w) => w.supervisor.host === me.host && w.supervisor.sessionID === me.sessionID)
    const seen = new Set<string>()
    for (const w of mine) {
      seen.add(w.sessionID)
      await this.onRoster(host, w.sessionID, { name: w.name, directory: w.directory, state: w.state })
    }
    for (const e of await this.state.roster()) {
      if (e.host === host && !seen.has(e.sessionID)) await this.onRoster(host, e.sessionID, { removed: true })
    }
  }

  /**
   * Reconcile every host. `all: true` (startup, explicit refresh) asks every configured peer so workers
   * spawned before a roster loss are re-adopted; otherwise only hosts that appear in the roster.
   */
  async reconcileAll(all = false): Promise<void> {
    const me = await this.state.supervisor()
    if (!me || me.host !== this.peers.self) return
    const hosts = all ? this.peers.all.map((p) => p.name) : [...new Set((await this.state.roster()).map((e) => e.host))]
    await Promise.all(hosts.map((host) => this.reconcile(me, host)))
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(t)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}
