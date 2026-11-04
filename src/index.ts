import { Plugin } from "@opencode/plugin"
import { z } from "zod"
import pkg from "../package.json" with { type: "json" }
import { PERM, registerAgents } from "./agents.ts"
import { ConfigError, loadMesh } from "./config.ts"
import { Peers, type Peer } from "./mesh.ts"
import { Observer, type RosterUpdate } from "./observe.ts"
import { Mesh, type Hello, type SupervisorRef, type Whoami, type WorkerInfo, type WorkerState } from "./rpc.ts"
import { State, type RosterEntry } from "./state.ts"
import { Steer, SteerError, supervisorAddress, type Target } from "./steer.ts"
import { Supervisor, describe, same } from "./supervisor.ts"
import { GLYPH, age } from "./view.ts"

export const VERSION: string = pkg.version

const TIMEOUT = 5_000

export type HostStatus =
  | { name: string; self: boolean; url: string; directory?: string; ok: true; hello: Hello; mismatch: boolean }
  | { name: string; self: boolean; url: string; directory?: string; ok: false; error: string }

export async function probe(peer: Peer, timeout = TIMEOUT): Promise<HostStatus> {
  const base = { name: peer.name, self: peer.self, url: peer.url, directory: peer.directory }
  try {
    const hello = await peer.rpc.hello({}, { signal: AbortSignal.timeout(timeout) })
    return { ...base, ok: true, hello, mismatch: hello.version !== VERSION }
  } catch (error) {
    return { ...base, ok: false, error: describe(error) }
  }
}

export function formatHosts(statuses: HostStatus[]): string {
  return statuses
    .map((s) => {
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
    .join("\n")
}

export function formatRoster(entries: RosterEntry[], now = Date.now()): string {
  if (entries.length === 0) return "No workers in the roster."
  return entries
    .map(
      (e) =>
        `${GLYPH[e.state]} ${e.host}/${e.name}  ${e.state}  ${age(now - e.lastSeen)}  ${e.sessionID}  ${e.directory}`,
    )
    .join("\n")
}

export function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const e = error as { _tag?: unknown; name?: unknown; type?: unknown }
  return e._tag === "SessionNotFoundError" || e.name === "SessionNotFoundError" || e.type === "no_session"
}

function parseFlags(text: string): Set<string> {
  return new Set(
    text
      .split(/\s+/)
      .filter((w) => w.startsWith("--"))
      .map((w) => w.slice(2)),
  )
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

    const state = new State(ctx.storage)
    const supervisor = new Supervisor(ctx, peers, state)
    const steer = new Steer(peers)

    const note = (sessionID: string, text: string) =>
      ctx.session.synthetic({ sessionID, text: `[mesh] ${text}` }).catch(() => {})

    // Nonces are minted by deliver() and consumed by the prompt hook. The plugin is instantiated once per
    // location, and the RPC handler and the target session's hook may run in different instances, so the
    // nonce lives in storage (shared across instances), not in memory.
    await ctx.session.hook("prompt", async (event) => {
      const mesh = event.metadata?.mesh
      const nonce =
        mesh && typeof mesh === "object" && "nonce" in mesh ? (mesh as { nonce?: unknown }).nonce : undefined
      if (typeof nonce !== "string") return
      const entry = await state.takeNonce(nonce)
      if (!entry) return
      event.prompt.text = `[mesh from ${entry.from.host}/${entry.from.name}] (${entry.kind})\n${event.prompt.text}`
      event.metadata = { ...event.metadata, mesh: { from: entry.from, kind: entry.kind, msgID: entry.msgID } }
    })

    /** Resolve "host/name", "name" (self), or a bare session id against the roster. */
    const resolve = async (ref: string): Promise<(Target & { name: string }) | undefined> => {
      const roster = await state.roster()
      const slash = ref.indexOf("/")
      const host = slash > 0 ? ref.slice(0, slash) : undefined
      const key = slash > 0 ? ref.slice(slash + 1) : ref
      return roster.find((e) => (host ? e.host === host : true) && (e.name === key || e.sessionID === key))
    }

    const requireSupervisor = async (sessionID: string): Promise<SupervisorRef | string> => {
      const ref = await state.supervisor()
      if (!ref || ref.host !== peers.self || ref.sessionID !== sessionID) {
        return "This session is not the supervisor. Run /super to claim it."
      }
      return ref
    }

    /** Single writer for roster/*: merges an update, emits the roster event, drops entries on removal. */
    const applyRoster = async (host: string, sessionID: string, update: RosterUpdate): Promise<boolean> => {
      const existing = await state.rosterEntry(host, sessionID)
      if (update.removed) {
        if (!existing) return false
        await state.removeRoster(host, sessionID)
        await rpc.events.emit("roster", { host, sessionID, name: existing.name, removed: true })
        return true
      }
      if (!existing && (!update.name || !update.directory)) return false
      const next = {
        name: update.name ?? existing!.name,
        directory: update.directory ?? existing!.directory,
        state: update.state ?? existing?.state ?? "idle",
        lastSeen: Date.now(),
      }
      await state.setRoster(host, sessionID, next)
      if (!existing || existing.state !== next.state || existing.name !== next.name) {
        await rpc.events.emit("roster", { host, sessionID, name: next.name, state: next.state })
      }
      return true
    }

    const observer = new Observer(ctx, peers, state, applyRoster)

    const stateOf = async (sessionID: string, active?: Record<string, unknown>): Promise<WorkerState> => {
      try {
        const info = await ctx.session.get({ sessionID })
        const running = active ?? (await peers.me.client.session.active())
        if (sessionID in running) return "busy"
        if (info.outcome === "failed") return "error"
        return "idle"
      } catch {
        return "lost"
      }
    }

    const whoami = async (sessionID: string): Promise<Whoami> => {
      const sup = await state.supervisor()
      if (sup?.host === peers.self && sup.sessionID === sessionID) {
        return { role: "supervisor", host: peers.self, sessionID, supervisor: sup }
      }
      const worker = await state.worker(sessionID)
      if (worker)
        return { role: "worker", host: peers.self, sessionID, name: worker.name, supervisor: worker.supervisor }
      return { role: "none", host: peers.self, sessionID }
    }

    const rpc = await ctx.rpc.register(Mesh, {
      async hello() {
        const [sup, workers] = await Promise.all([state.supervisor(), state.workers()])
        return { host: peers.self, version: VERSION, workers: workers.length, ...(sup ? { supervisor: sup } : {}) }
      },

      async claim(input) {
        const result = await supervisor.handleClaim(input)
        if (result.ok) {
          await rpc.events.emit("supervisor", input.release ? { released: true } : { supervisor: input })
        }
        return result
      },

      async register(input, { error }) {
        for (const w of await state.workers()) {
          if (w.name === input.name && w.sessionID !== input.sessionID) {
            return error("name_taken", `worker name "${input.name}" is already used on ${peers.self}`, {
              name: input.name,
              sessionID: w.sessionID,
            })
          }
        }
        await state.setWorker(input.sessionID, {
          name: input.name,
          directory: input.directory,
          supervisor: input.supervisor,
          createdAt: Date.now(),
        })
        await ctx.session.instructions.entry
          .put({
            sessionID: input.sessionID,
            key: "mesh.identity",
            value: { role: "worker", name: input.name, host: peers.self, supervisor: input.supervisor },
          })
          .catch(() => {})
        await rpc.events.emit("worker", { sessionID: input.sessionID, name: input.name })
        return { ok: true }
      },

      async unregister({ sessionID }) {
        const existing = await state.worker(sessionID)
        if (!existing) return { removed: false }
        await state.removeWorker(sessionID)
        await ctx.session.instructions.entry.remove({ sessionID, key: "mesh.identity" }).catch(() => {})
        await rpc.events.emit("worker", { sessionID, removed: true })
        return { removed: true }
      },

      async list() {
        const workers = await state.workers()
        const active = await peers.me.client.session.active().catch(() => ({}))
        const out: WorkerInfo[] = await Promise.all(
          workers.map(async (w) => ({
            sessionID: w.sessionID,
            name: w.name,
            directory: w.directory,
            supervisor: w.supervisor,
            state: await stateOf(w.sessionID, active),
          })),
        )
        return { workers: out }
      },

      async whoami({ sessionID }) {
        return whoami(sessionID)
      },

      async notify(input) {
        const me = await state.supervisor()
        if (!me || me.host !== peers.self) return { known: false }
        const known = await applyRoster(
          input.host,
          input.sessionID,
          input.removed ? { removed: true } : { state: input.state },
        )
        return { known }
      },

      async roster({ refresh }) {
        const sup = await state.supervisor()
        if (!sup || sup.host !== peers.self)
          return { host: peers.self, ...(sup ? { supervisor: sup } : {}), entries: [] }
        if (refresh) await observer.reconcileAll(true)
        return { host: peers.self, supervisor: sup, entries: await state.roster() }
      },

      async read({ host, sessionID, tail }, { error }) {
        const sup = await state.supervisor()
        const entry = sup?.host === peers.self ? await state.rosterEntry(host, sessionID) : undefined
        if (!entry)
          return error("unauthorized", `${host}/${sessionID} is not in this host's roster`, { reason: "not-in-roster" })
        try {
          return { text: await steer.read({ host, sessionID }, tail ?? 50) }
        } catch (cause) {
          return { text: `(transcript unavailable: ${describe(cause)})` }
        }
      },

      async deliver(input, { error }) {
        const sup = await state.supervisor()
        const worker = await state.worker(input.to)
        if (worker) {
          if (!same(worker.supervisor, input.from)) {
            return error(
              "unauthorized",
              `only the supervisor ${worker.supervisor.host}/${worker.supervisor.sessionID} may message worker ${worker.name}`,
              {
                reason: "not-supervisor",
              },
            )
          }
        } else if (sup && sup.host === peers.self && sup.sessionID === input.to) {
          const known = await state.rosterEntry(input.from.host, input.from.sessionID)
          if (!known) {
            return error(
              "unauthorized",
              `${input.from.host}/${input.from.sessionID} is not a worker in the supervisor's roster`,
              { reason: "not-in-roster" },
            )
          }
        } else {
          return error(
            "unauthorized",
            `session ${input.to} is neither a mesh worker nor the supervisor on ${peers.self}`,
            { reason: "not-mesh-session" },
          )
        }

        const nonce = crypto.randomUUID()
        await state.setNonce(nonce, { from: input.from, kind: input.kind, msgID: input.msgID, createdAt: Date.now() })
        try {
          await ctx.session.prompt({
            sessionID: input.to,
            id: input.msgID,
            text: input.body,
            delivery: input.delivery,
            metadata: { mesh: { nonce } },
          })
        } catch (cause) {
          await state.takeNonce(nonce)
          if (isNotFound(cause))
            return error("no_session", `session ${input.to} does not exist on ${peers.self}`, { sessionID: input.to })
          throw cause
        }
        await rpc.events.emit("message", { from: input.from, to: input.to, kind: input.kind, msgID: input.msgID })
        return { delivered: true }
      },
    })

    await registerAgents(ctx)

    await ctx.command.transform((editor) => {
      editor.add({
        name: "super",
        description: "Claim the mesh supervisor role for this session. Flags: --status, --force, --release",
        execute: async ({ sessionID, prompt }) => {
          const flags = parseFlags(prompt.text)

          if (flags.has("status")) {
            const rows = await supervisor.status()
            const views = new Set(
              rows
                .filter((r) => r.ok)
                .map((r) => (r.ok && r.supervisor ? `${r.supervisor.host}/${r.supervisor.sessionID}` : "none")),
            )
            const lines = rows.map((r) => {
              const tag = r.self ? " (self)" : ""
              if (!r.ok) return `✗ ${r.peer}${tag}  unreachable: ${r.error}`
              return `● ${r.peer}${tag}  ${r.supervisor ? `${r.supervisor.host}/${r.supervisor.sessionID} (claimed ${age(Date.now() - r.supervisor.claimedAt)} ago)` : "no supervisor"}`
            })
            const verdict =
              views.size > 1
                ? "\nDISAGREEMENT: hosts do not agree on the supervisor. Resolve with /super --force from the side that should win."
                : ""
            await note(sessionID, `supervisor status\n${lines.join("\n")}${verdict}`)
            return
          }

          if (flags.has("release")) {
            const result = await supervisor.release(sessionID)
            if (!result.ok) {
              await note(
                sessionID,
                result.held
                  ? `this session is not the supervisor; ${result.held.host}/${result.held.sessionID} holds it.`
                  : "no supervisor claim to release.",
              )
              return
            }
            await rpc.events.emit("supervisor", { released: true })
            const skipped = result.unreachable.length ? ` Unreachable: ${result.unreachable.join(", ")}.` : ""
            await note(
              sessionID,
              `supervisor released. Interrupted ${result.interrupted} worker(s); they stay registered.${skipped}`,
            )
            return
          }

          const result = await supervisor.claim(sessionID, { force: flags.has("force") })
          if (!result.ok) {
            const where = result.reason === "local-held" ? "this host" : result.on
            await note(
              sessionID,
              `claim refused: ${result.held.host}/${result.held.sessionID} holds the supervisor (reported by ${where}). Use /super --force to take it.`,
            )
            return
          }
          await ctx.session
            .switchAgent({ sessionID, agent: "super" })
            .catch((e) => console.warn(`[madcat] switchAgent failed: ${describe(e)}`))
          await ctx.session.instructions.entry
            .put({ sessionID, key: "mesh.identity", value: { role: "supervisor", host: peers.self, sessionID } })
            .catch(() => {})
          await rpc.events.emit("supervisor", { supervisor: result.ref })
          const roster = await state.roster()
          const adopted = roster.length
            ? ` Adopted ${roster.length} existing roster entr${roster.length === 1 ? "y" : "ies"}.`
            : ""
          const skipped = result.unreachable.length
            ? ` Unreachable (will learn on next contact): ${result.unreachable.join(", ")}.`
            : ""
          await note(sessionID, `this session is now the mesh supervisor on ${peers.self}.${adopted}${skipped}`)
        },
      })
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "mesh", description: "MADCAT mesh: hosts and sessions" })

      editor.add({
        name: "hosts",
        description:
          "List every host in the mesh with reachability, plugin version, supervisor claim and default spawn directory. Self is marked.",
        input: z.object({}),
        options: { namespace: "mesh", permission: PERM.super },
        execute: async () => {
          const statuses = await Promise.all(peers.all.map((p) => probe(p)))
          return { content: formatHosts(statuses) }
        },
      })

      editor.add({
        name: "whoami",
        description: "Show this session's mesh role, host, name and supervisor location.",
        input: z.object({}),
        options: { namespace: "mesh", permission: PERM.common },
        execute: async (_input, context) => {
          const me = await whoami(context.sessionID)
          const lines = [`role: ${me.role}`, `host: ${me.host}`, `session: ${me.sessionID}`]
          if (me.name) lines.push(`name: ${me.name}`)
          if (me.supervisor) lines.push(`supervisor: ${me.supervisor.host}/${me.supervisor.sessionID}`)
          return { content: lines.join("\n") }
        },
      })

      editor.add({
        name: "sessions",
        description:
          "Worker roster seen by the supervisor. Optional filters by host and state. refresh=true asks every host for its live worker list first.",
        input: z.object({
          host: z.string().optional().describe("only workers on this host"),
          state: z.enum(["spawning", "idle", "busy", "error", "done", "lost"]).optional(),
          refresh: z.boolean().optional().describe("re-query every host before listing"),
        }),
        options: { namespace: "mesh", permission: PERM.super },
        execute: async (input, context) => {
          if (!(await supervisor.isSupervisor(context.sessionID))) {
            return { content: "Only the supervisor can list the roster. Run /super to claim it." }
          }
          if (input.refresh) await refreshRoster()
          let entries = await state.roster()
          if (input.host) entries = entries.filter((e) => e.host === input.host)
          if (input.state) entries = entries.filter((e) => e.state === input.state)
          return { content: formatRoster(entries) }
        },
      })

      // --- steering tools (supervisor only) ---

      const target = async (ref: string) => {
        const found = await resolve(ref)
        if (!found)
          throw new SteerError(
            `no worker "${ref}" in the roster. Use host/name, name, or a session id; mesh_sessions lists them.`,
          )
        return found
      }

      const run = async (sessionID: string, fn: (sup: SupervisorRef) => Promise<string>) => {
        const sup = await requireSupervisor(sessionID)
        if (typeof sup === "string") return { content: sup }
        try {
          return { content: await fn(sup) }
        } catch (error) {
          if (error instanceof SteerError) return { content: `error: ${error.message}` }
          return { content: `error: ${describe(error)}` }
        }
      }

      editor.add({
        name: "spawn",
        description:
          "Create a mesh worker session on a host and give it standing orders. host defaults to this host; directory defaults to the host's configured default. Returns the worker's mesh address. Optional prompt is queued as the first order.",
        input: z.object({
          name: z
            .string()
            .regex(/^[a-z0-9][a-z0-9_-]*$/)
            .describe("short unique worker name on that host"),
          orders: z.string().describe("the brief: goal, boundaries, definition of done, what to report"),
          host: z.string().optional().describe("mesh host name; defaults to self"),
          directory: z.string().optional().describe("absolute working directory; defaults to the host's default"),
          prompt: z.string().optional().describe("first message to the worker, queued after spawn"),
        }),
        options: { namespace: "mesh", permission: PERM.super },
        execute: (input, context) =>
          run(context.sessionID, async (sup) => {
            const host = input.host ?? peers.self
            const peer = peers.get(host)
            if (!peer) throw new SteerError(`unknown host "${host}"`)
            const directory = input.directory ?? peer.directory
            if (!directory) throw new SteerError(`host ${host} has no default directory; pass one`)
            if (await resolve(`${host}/${input.name}`))
              throw new SteerError(`worker ${host}/${input.name} already exists`)
            const t = await steer.spawn(sup, {
              host,
              name: input.name,
              directory,
              orders: input.orders,
              prompt: input.prompt,
            })
            await applyRoster(host, t.sessionID, { name: input.name, directory, state: "spawning" })
            return `spawned ${host}/${input.name} (${t.sessionID}) in ${directory}${input.prompt ? "; first order queued" : ""}`
          }),
      })

      editor.add({
        name: "send",
        description:
          "Send a message to a worker. kind 'order' directs it, 'ask' requests information, 'answer' replies to its ask. delivery 'steer' interrupts the current step; 'queue' waits until the worker is idle.",
        input: z.object({
          to: z.string().describe("worker as host/name, name, or session id"),
          text: z.string(),
          kind: z.enum(["order", "ask", "answer"]).optional().describe("default order"),
          delivery: z.enum(["steer", "queue"]).optional().describe("default steer"),
        }),
        options: { namespace: "mesh", permission: PERM.super },
        execute: (input, context) =>
          run(context.sessionID, async (sup) => {
            const t = await target(input.to)
            const msgID = await steer.send(t, {
              from: supervisorAddress(sup),
              kind: input.kind ?? "order",
              body: input.text,
              delivery: input.delivery ?? "steer",
            })
            return `delivered ${input.kind ?? "order"} to ${t.host}/${t.name} (${input.delivery ?? "steer"}, id ${msgID})`
          }),
      })

      editor.add({
        name: "orders",
        description:
          "Replace a worker's standing orders (its mesh.orders context block), or remove them. The worker sees the change at its next step without being interrupted.",
        input: z.object({
          to: z.string().describe("worker as host/name, name, or session id"),
          value: z.string().optional().describe("new orders; omit together with remove=true to clear"),
          remove: z.boolean().optional(),
        }),
        options: { namespace: "mesh", permission: PERM.super },
        execute: (input, context) =>
          run(context.sessionID, async () => {
            const t = await target(input.to)
            if (input.remove) {
              await steer.orders(t, undefined)
              return `orders removed from ${t.host}/${t.name}`
            }
            if (input.value === undefined) throw new SteerError("pass value, or remove=true")
            await steer.orders(t, input.value)
            return `orders updated for ${t.host}/${t.name}`
          }),
      })

      editor.add({
        name: "read",
        description: "Read the tail of a worker's transcript: user turns, assistant text, and tool calls.",
        input: z.object({
          to: z.string().describe("worker as host/name, name, or session id"),
          tail: z.number().int().positive().optional().describe("number of lines from the end; default 50"),
        }),
        options: { namespace: "mesh", permission: PERM.super },
        execute: (input, context) =>
          run(context.sessionID, async () => {
            const t = await target(input.to)
            return `transcript of ${t.host}/${t.name} (${t.sessionID}):\n${await steer.read(t, input.tail ?? 50)}`
          }),
      })

      editor.add({
        name: "interrupt",
        description:
          "Stop a worker's current turn. resume=true lets it continue after handling queued messages; default false.",
        input: z.object({
          to: z.string().describe("worker as host/name, name, or session id"),
          resume: z.boolean().optional(),
        }),
        options: { namespace: "mesh", permission: PERM.super },
        execute: (input, context) =>
          run(context.sessionID, async () => {
            const t = await target(input.to)
            const did = await steer.interrupt(t, input.resume ?? false)
            return did
              ? `interrupted ${t.host}/${t.name}${input.resume ? " (will resume)" : ""}`
              : `${t.host}/${t.name} was not running`
          }),
      })

      editor.add({
        name: "wait",
        description:
          "Block until a worker is idle (up to 30 minutes). Prefer waiting for its report; use this when you need the result synchronously.",
        input: z.object({
          to: z.string().describe("worker as host/name, name, or session id"),
          timeout: z.number().int().positive().optional().describe("seconds; default 1800"),
        }),
        options: { namespace: "mesh", permission: PERM.super },
        execute: (input, context) =>
          run(context.sessionID, async () => {
            const t = await target(input.to)
            const started = Date.now()
            await steer.wait(t, input.timeout ? input.timeout * 1000 : undefined)
            return `${t.host}/${t.name} is idle (waited ${age(Date.now() - started)})`
          }),
      })

      editor.add({
        name: "remove",
        description: "End a worker: unregister it, delete its session, and drop it from the roster.",
        input: z.object({
          to: z.string().describe("worker as host/name, name, or session id"),
        }),
        options: { namespace: "mesh", permission: PERM.super },
        execute: (input, context) =>
          run(context.sessionID, async () => {
            const t = await target(input.to)
            await applyRoster(t.host, t.sessionID, { removed: true })
            await steer.remove(t)
            return `removed ${t.host}/${t.name} (${t.sessionID})`
          }),
      })

      // --- worker tools: upward only, target read from workers/<me>, never supplied by the caller ---

      const upward = async (sessionID: string, kind: "report" | "ask", text: string) => {
        const worker = await state.worker(sessionID)
        if (!worker) return { content: "This session is not a mesh worker." }
        try {
          const msgID = await steer.send(
            { host: worker.supervisor.host, sessionID: worker.supervisor.sessionID },
            { from: { host: peers.self, sessionID, name: worker.name }, kind, body: text, delivery: "steer" },
          )
          return { content: `${kind} delivered to the supervisor on ${worker.supervisor.host} (id ${msgID})` }
        } catch (error) {
          return { content: `error: ${kind} not delivered: ${describe(error)}` }
        }
      }

      editor.add({
        name: "report",
        description:
          "Report to the supervisor: unit done, blocked, or a finding that changes the plan. Wakes the supervisor. Include what you did, what changed, what is left, and what it must decide.",
        input: z.object({ text: z.string().min(1) }),
        options: { namespace: "mesh", permission: PERM.worker },
        execute: (input, context) => upward(context.sessionID, "report", input.text),
      })

      editor.add({
        name: "ask",
        description:
          "Ask the supervisor a question it must answer. Keep working on anything that does not depend on the answer; the reply arrives as a [mesh from …] (answer) message.",
        input: z.object({ text: z.string().min(1) }),
        options: { namespace: "mesh", permission: PERM.worker },
        execute: (input, context) => upward(context.sessionID, "ask", input.text),
      })
    })

    const refreshRoster = () => observer.reconcileAll(true)

    observer.start()
    void observer.reconcileAll(true).catch((e) => console.warn(`[madcat] startup reconcile: ${describe(e)}`))
    void state.pruneNonces().catch(() => {})

    return () => observer.stop()
  },
})

export type { SupervisorRef }
