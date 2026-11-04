/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { JSX } from "solid-js"
import plugin from "../src/tui.tsx"
import type { RosterRow, Whoami } from "../src/rpc.ts"

type Handler = (event: { data: any }) => void

function fake(options: { roster: RosterRow[]; whoami: Whoami; supervisorHere?: boolean }) {
  const c = RGBA.fromInts(200, 200, 200)
  const slots: Record<string, Array<(input: any) => JSX.Element>> = {}
  const handlers: Record<string, Handler[]> = {}
  const toasts: Array<{ title?: string; message: string; variant?: string }> = []
  const panels: string[] = []
  const sup = { host: "fuji", sessionID: "ses_super", claimedAt: 1 }
  const rpc = {
    roster: async () => ({ host: "fuji", ...(options.supervisorHere === false ? {} : { supervisor: sup }), entries: options.roster }),
    whoami: async () => options.whoami,
    read: async () => ({ text: "[assistant] hello" }),
    events: {
      on: (name: string, h: Handler) => {
        ;(handlers[name] ??= []).push(h)
        return () => {}
      },
    },
  }
  const feedback = { base: c, muted: c }
  const context = {
    theme: {
      text: { base: c, muted: c, faint: c, action: { primary: { base: c } }, feedback: { error: feedback, warning: feedback, success: feedback, info: feedback } },
      background: { raised: { high: c } },
    },
    client: { rpc: () => rpc },
    ui: {
      slot: (claim: { append: string; render: (input: any) => JSX.Element }) => void (slots[claim.append] ??= []).push(claim.render),
      toast: { show: (t: (typeof toasts)[number]) => void toasts.push(t) },
      panel: { open: (name: string) => (panels.push(name), true), close: () => {}, current: () => undefined },
      format: { path: (p: string) => p },
      tabs: { enabled: () => false, focus: () => false },
      router: { navigate: () => {} },
      dialog: { alert: async () => {} },
    },
    keymap: { layer: () => {} },
    attention: { notify: async () => ({ ok: true }) },
    data: { session: { status: () => "idle" } },
  } as unknown as Context
  return { context, slots, handlers, toasts, panels, sup }
}

const rows: RosterRow[] = [
  { host: "fuji", sessionID: "ses_a", name: "indexer", directory: "/p/a", state: "busy", lastSeen: Date.now() },
  { host: "sin", sessionID: "ses_b", name: "reviewer", directory: "/p/b", state: "idle", lastSeen: Date.now() },
  { host: "junk", sessionID: "ses_c", name: "bench", directory: "/p/c", state: "lost", lastSeen: Date.now() },
]

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

async function mount(f: ReturnType<typeof fake>, slot: string, input: unknown, width = 44, height = 14) {
  const cleanup = await plugin.setup(f.context)
  if (cleanup) cleanups.push(() => void cleanup())
  const render = f.slots[slot]![0]!
  const app = await testRender(
    () => (
      <PluginContextProvider value={f.context}>
        <box width={width}>{render(input)}</box>
      </PluginContextProvider>
    ),
    { width, height },
  )
  cleanups.push(() => app.renderer.destroy())
  // let the roster/whoami promises resolve, then paint
  for (let i = 0; i < 4; i++) {
    await Bun.sleep(5)
    await app.renderOnce()
  }
  return app
}

describe("tui", () => {
  test("registers every slot from the plan", async () => {
    const f = fake({ roster: [], whoami: { role: "none", host: "fuji", sessionID: "x" } })
    const cleanup = await plugin.setup(f.context)
    if (cleanup) cleanups.push(() => void cleanup())
    expect(Object.keys(f.slots).sort()).toEqual(["app", "home.footer.status", "prompt.footer.status", "session.panel", "sidebar.content"])
  })

  test("sidebar on the supervisor shows the roster, problems first, and a summary", async () => {
    const f = fake({ roster: rows, whoami: { role: "supervisor", host: "fuji", sessionID: "ses_super" } })
    const app = await mount(f, "sidebar.content", { sessionID: "ses_super" })
    const frame = app.captureCharFrame()
    expect(frame).toContain("MESH supervisor · fuji")
    const lines = frame.split("\n")
    const at = (s: string) => lines.findIndex((l) => l.includes(s))
    expect(at("junk/bench")).toBeGreaterThan(-1)
    expect(at("junk/bench")).toBeLessThan(at("fuji/indexer"))
    expect(at("fuji/indexer")).toBeLessThan(at("sin/reviewer"))
    expect(frame).toContain("3 hosts · 3 workers · 1 need attention")
  })

  test("sidebar on a worker shows identity, on anything else a hint", async () => {
    const w = fake({ roster: [], whoami: { role: "worker", host: "sin", sessionID: "ses_w", name: "reviewer", supervisor: { host: "fuji", sessionID: "ses_super", claimedAt: 1 } } })
    const wf = (await mount(w, "sidebar.content", { sessionID: "ses_w" })).captureCharFrame()
    expect(wf).toContain("MESH worker · sin/reviewer")
    expect(wf).toContain("supervisor fuji/ses_super")
    while (cleanups.length) cleanups.pop()!()

    const n = fake({ roster: [], whoami: { role: "none", host: "fuji", sessionID: "x" } })
    expect((await mount(n, "sidebar.content", { sessionID: "x" })).captureCharFrame()).toContain("not a mesh session · /super")
  })

  test("footer status shows counts only when the supervisor is on this host", async () => {
    const f = fake({ roster: rows, whoami: { role: "supervisor", host: "fuji", sessionID: "ses_super" } })
    expect((await mount(f, "home.footer.status", {})).captureCharFrame()).toContain("MESH 3 ●1 ○1 ✗1")
    while (cleanups.length) cleanups.pop()!()

    const g = fake({ roster: [], whoami: { role: "none", host: "fuji", sessionID: "x" }, supervisorHere: false })
    expect((await mount(g, "home.footer.status", {})).captureCharFrame()).not.toContain("MESH")
  })

  test("panel renders the roster with directories and a transcript preview", async () => {
    const f = fake({ roster: rows, whoami: { role: "supervisor", host: "fuji", sessionID: "ses_super" } })
    const panel = { name: "mesh.roster", sessionID: "ses_super", width: 80, presentation: "panel", focused: true, focus() {}, close() {}, toggleFullscreen() {} }
    const frame = (await mount(f, "session.panel", panel, 80, 20)).captureCharFrame()
    expect(frame).toContain("supervisor fuji/ses_super")
    expect(frame).toContain("/p/a")
    expect(frame).toContain("[assistant] hello")
  })

  test("events: report toasts for the supervisor, degraded state toasts error, removal drops the row", async () => {
    const f = fake({ roster: rows, whoami: { role: "supervisor", host: "fuji", sessionID: "ses_super" } })
    const app = await mount(f, "sidebar.content", { sessionID: "ses_super" })

    f.handlers.message!.forEach((h) => h({ data: { from: { host: "sin", sessionID: "ses_b", name: "reviewer" }, to: "ses_super", kind: "report", msgID: "msg_1" } }))
    f.handlers.message!.forEach((h) => h({ data: { from: { host: "fuji", sessionID: "ses_super", name: "super" }, to: "ses_b", kind: "order", msgID: "msg_2" } }))
    expect(f.toasts.map((t) => t.title)).toEqual(["[sin/reviewer] report"])

    f.handlers.roster!.forEach((h) => h({ data: { host: "fuji", sessionID: "ses_a", name: "indexer", state: "error" } }))
    expect(f.toasts.at(-1)).toMatchObject({ variant: "error", message: "fuji/indexer is error" })

    f.handlers.roster!.forEach((h) => h({ data: { host: "sin", sessionID: "ses_b", removed: true } }))
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("sin/reviewer")
    expect(frame).toContain("2 hosts · 2 workers · 2 need attention")
  })
})
