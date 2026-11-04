import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { Peers } from "../src/mesh.ts"
import { Observer, WATCHED, transition, type RosterUpdate } from "../src/observe.ts"
import type { WorkerInfo } from "../src/rpc.ts"
import { State } from "../src/state.ts"

describe("transition", () => {
  test("maps execution events to worker states", () => {
    expect(transition("session.execution.started")).toEqual({ state: "busy" })
    expect(transition("session.execution.succeeded")).toEqual({ state: "idle" })
    expect(transition("session.execution.interrupted")).toEqual({ state: "idle" })
    expect(transition("session.execution.failed")).toEqual({ state: "error" })
    expect(transition("session.deleted")).toEqual({ state: "done", removed: true })
    expect(transition("session.idle")).toBeUndefined()
  })

  test("every watched type has a transition", () => {
    for (const type of WATCHED) expect(transition(type)).toBeDefined()
  })
})

function memoryStorage() {
  const map = new Map<string, unknown>()
  return {
    get: async (key: string) => map.get(key),
    set: async (key: string, value: unknown) => void map.set(key, value),
    remove: async (key: string) => void map.delete(key),
    scan: async ({ prefix }: { prefix: string }) => ({
      entries: [...map.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    }),
  } as unknown as ConstructorParameters<typeof State>[0]
}

interface FakePeer {
  name: string
  self: boolean
  up: boolean
  workers: WorkerInfo[]
  calls: string[]
}

function fakePeers(
  self: string,
  hosts: Record<string, Partial<FakePeer>>,
): { peers: Peers; fakes: Record<string, FakePeer> } {
  const fakes: Record<string, FakePeer> = {}
  for (const [name, opts] of Object.entries(hosts)) {
    fakes[name] = { name, self: name === self, up: true, workers: [], calls: [], ...opts }
  }
  const peer = (f: FakePeer) => ({
    name: f.name,
    url: `http://${f.name}`,
    self: f.self,
    client: {},
    rpc: {
      hello: async () => {
        f.calls.push("hello")
        if (!f.up) throw new Error("down")
        return { host: f.name, version: "t", workers: f.workers.length }
      },
      list: async () => {
        f.calls.push("list")
        if (!f.up) throw new Error("down")
        return { workers: f.workers }
      },
      notify: async (input: unknown) => {
        f.calls.push(`notify:${JSON.stringify(input)}`)
        if (!f.up) throw new Error("down")
        return { known: true }
      },
    },
  })
  const all = Object.values(fakes).map(peer)
  const peers = {
    self,
    all,
    get: (name: string) => all.find((p) => p.name === name),
    get me() {
      return all.find((p) => p.self)!
    },
    get others() {
      return all.filter((p) => !p.self)
    },
  } as unknown as Peers
  return { peers, fakes }
}

const me = { host: "fuji", sessionID: "ses_super", claimedAt: 1 }

function setup(hosts: Record<string, Partial<FakePeer>>, options?: ConstructorParameters<typeof Observer>[4]) {
  const { peers, fakes } = fakePeers("fuji", hosts)
  const state = new State(memoryStorage())
  const updates: Array<{ host: string; sessionID: string; update: RosterUpdate }> = []
  const onRoster = async (host: string, sessionID: string, update: RosterUpdate) => {
    updates.push({ host, sessionID, update })
    const existing = await state.rosterEntry(host, sessionID)
    if (update.removed) return state.removeRoster(host, sessionID)
    await state.setRoster(host, sessionID, {
      name: update.name ?? existing?.name ?? "?",
      directory: update.directory ?? existing?.directory ?? "/",
      state: update.state ?? existing?.state ?? "idle",
      lastSeen: 0,
    })
  }
  const ctx = { event: { subscribe: () => (async function* () {})() } } as unknown as Plugin.Context
  const observer = new Observer(ctx, peers, state, onRoster, { retries: [], ...options })
  return { observer, state, fakes, updates }
}

describe("Observer.ping", () => {
  test("marks a host lost after N consecutive failures and recovers with a reconcile", async () => {
    const { observer, state, fakes, updates } = setup({ fuji: {}, sin: {} }, { pingFailures: 2 })
    await state.setSupervisor(me)
    await state.setRoster("sin", "ses_w", { name: "w", directory: "/w", state: "busy", lastSeen: 0 })
    fakes.sin!.up = false

    await observer.ping()
    expect(updates).toHaveLength(0)
    await observer.ping()
    expect(updates).toEqual([{ host: "sin", sessionID: "ses_w", update: { state: "lost" } }])
    expect((await state.rosterEntry("sin", "ses_w"))?.state).toBe("lost")

    fakes.sin!.up = true
    fakes.sin!.workers = [{ sessionID: "ses_w", name: "w", directory: "/w", supervisor: me, state: "idle" }]
    await observer.ping()
    expect(fakes.sin!.calls.at(-1)).toBe("list")
    expect((await state.rosterEntry("sin", "ses_w"))?.state).toBe("idle")
  })

  test("only pings hosts that appear in the roster, and only when this host is the supervisor", async () => {
    const { observer, state, fakes } = setup({ fuji: {}, sin: {}, forge: {} })
    await observer.ping()
    expect(fakes.sin!.calls).toHaveLength(0)
    await state.setSupervisor(me)
    await state.setRoster("sin", "ses_w", { name: "w", directory: "/w", state: "idle", lastSeen: 0 })
    await observer.ping()
    expect(fakes.sin!.calls).toEqual(["hello"])
    expect(fakes.forge!.calls).toHaveLength(0)
  })
})

describe("Observer.reconcile", () => {
  test("adopts live workers, drops vanished ones, ignores other supervisors' workers", async () => {
    const { observer, state, fakes } = setup({ fuji: {}, sin: {} })
    await state.setSupervisor(me)
    await state.setRoster("sin", "ses_gone", { name: "gone", directory: "/g", state: "busy", lastSeen: 0 })
    fakes.sin!.workers = [
      { sessionID: "ses_a", name: "a", directory: "/a", supervisor: me, state: "busy" },
      {
        sessionID: "ses_b",
        name: "b",
        directory: "/b",
        supervisor: { host: "sin", sessionID: "ses_other", claimedAt: 2 },
        state: "idle",
      },
    ]
    await observer.reconcileAll(true)
    const roster = await state.roster()
    expect(roster.map((e) => `${e.host}/${e.name}:${e.state}`).toSorted()).toEqual(["sin/a:busy"])
  })

  test("an unreachable host marks its entries lost", async () => {
    const { observer, state, fakes } = setup({ fuji: {}, sin: { up: false } })
    await state.setSupervisor(me)
    await state.setRoster("sin", "ses_w", { name: "w", directory: "/w", state: "busy", lastSeen: 0 })
    await observer.reconcileAll()
    expect((await state.rosterEntry("sin", "ses_w"))?.state).toBe("lost")
    expect(fakes.fuji!.calls).toHaveLength(0)
  })
})

describe("Observer.notify", () => {
  test("delivers to the supervisor's host and reports failure when it is down", async () => {
    const { observer, fakes } = setup({ fuji: {}, sin: {} })
    const input = { host: "fuji", sessionID: "ses_w", state: "idle" as const, at: 5 }
    expect(await observer.notify({ host: "sin", sessionID: "ses_s", claimedAt: 1 }, input)).toBe(true)
    expect(fakes.sin!.calls).toEqual([`notify:${JSON.stringify(input)}`])
    fakes.sin!.up = false
    expect(await observer.notify({ host: "sin", sessionID: "ses_s", claimedAt: 1 }, input)).toBe(false)
    expect(await observer.notify({ host: "nowhere", sessionID: "ses_s", claimedAt: 1 }, input)).toBe(false)
  })
})
