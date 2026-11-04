/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { createMemo, createResource, createRoot, createSignal, For, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Mesh, type RosterRow, type SupervisorRef, type Whoami, type WorkerState } from "./rpc.ts"
import { GLYPH, TONE, age, counts, degraded, footer, notable, short, sortRows, summary, type Tone } from "./view.ts"

const PANEL = "mesh.roster"
const TICK = 5_000

type Context = Plugin.Context
type MeshClient = ReturnType<Context["client"]["rpc"]>

/**
 * Shared, reactive mesh view for one TUI. Loaded from `mesh.roster` and kept fresh by the
 * `roster` / `supervisor` / `worker` events. The TUI holds no mesh logic of its own.
 */
function createMeshStore(context: Context) {
  const rpc = () => context.client.rpc(Mesh)
  const [view, setView] = createStore<{ host?: string; supervisor?: SupervisorRef; rows: RosterRow[]; error?: string }>({ rows: [] })
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), TICK)

  const load = async (refresh = false) => {
    try {
      const r = await rpc().roster(refresh ? { refresh: true } : {})
      setView({ host: r.host, supervisor: r.supervisor, error: undefined })
      setView("rows", reconcile(r.entries, { key: "sessionID" }))
    } catch (e) {
      setView("error", e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e))
    }
  }

  const stops = [
    rpc().events.on("roster", (event) => {
      const d = event.data
      const prev = view.rows.find((r) => r.host === d.host && r.sessionID === d.sessionID)
      if (d.removed) {
        setView("rows", (rows) => rows.filter((r) => !(r.host === d.host && r.sessionID === d.sessionID)))
        return
      }
      if (degraded(prev?.state, d.state)) {
        context.ui.toast.show({ title: "mesh", message: `${d.host}/${d.name ?? prev?.name ?? short(d.sessionID)} is ${d.state}`, variant: "error" })
      }
      if (!prev) return void load()
      setView("rows", (r) => r.host === d.host && r.sessionID === d.sessionID, (r) => ({
        ...r,
        ...(d.name ? { name: d.name } : {}),
        ...(d.state ? { state: d.state } : {}),
        lastSeen: Date.now(),
      }))
    }),
    rpc().events.on("supervisor", () => void load()),
    rpc().events.on("message", (event) => {
      const d = event.data
      if (!view.supervisor || d.to !== view.supervisor.sessionID || !notable(d.kind)) return
      const who = `${d.from.host}/${d.from.name}`
      context.ui.toast.show({ title: `[${who}] ${d.kind}`, message: d.kind === "ask" ? "waiting on you" : "new report", variant: d.kind === "ask" ? "warning" : "info", sessionID: d.to })
      void context.attention.notify({ title: `mesh · ${who}`, message: d.kind, notification: { when: "blurred" }, sound: { name: d.kind === "ask" ? "question" : "done", when: "blurred" } })
    }),
  ]

  void load()
  const dispose = () => {
    clearInterval(timer)
    for (const stop of stops) stop()
  }

  const sorted = createMemo(() => sortRows(view.rows))
  const tally = createMemo(() => counts(view.rows))
  return { view, sorted, tally, now, load, rpc, dispose }
}

type MeshStore = ReturnType<typeof createMeshStore>

function tone(context: Context, t: Tone) {
  const th = context.theme
  switch (t) {
    case "accent":
      return th.text.action.primary.base
    case "muted":
      return th.text.muted
    case "warning":
      return th.text.feedback.warning.base
    case "error":
      return th.text.feedback.error.base
    case "success":
      return th.text.feedback.success.base
  }
}

const stateColor = (context: Context, s: WorkerState) => tone(context, TONE[s])

/** Open a worker: focus its tab when it lives on this host, otherwise show its transcript tail. */
async function openWorker(context: Context, store: MeshStore, row: RosterRow) {
  if (row.host === store.view.host && context.ui.tabs.enabled() && context.ui.tabs.focus(row.sessionID)) return
  if (row.host === store.view.host) return context.ui.router.navigate({ type: "session", sessionID: row.sessionID })
  let text: string
  try {
    text = (await store.rpc().read({ host: row.host, sessionID: row.sessionID, tail: 40 })).text
  } catch (e) {
    text = `transcript unavailable: ${(e as { message?: string })?.message ?? String(e)}`
  }
  await context.ui.dialog.alert({ title: `${row.host}/${row.name}`, message: text })
}

function Row(props: { store: MeshStore; row: RosterRow; selected?: boolean; wide?: boolean; onPick?: () => void }) {
  const context = usePlugin()
  const th = context.theme
  return (
    <box flexDirection="row" gap={1} minWidth={0} onMouseUp={() => props.onPick?.()} backgroundColor={props.selected ? th.background.raised.high : undefined}>
      <text flexShrink={0} fg={stateColor(context, props.row.state)}>
        {GLYPH[props.row.state]}
      </text>
      <text fg={th.text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
        {props.row.host}/{props.row.name}
      </text>
      <text flexShrink={0} fg={stateColor(context, props.row.state)}>
        {props.row.state}
      </text>
      <text flexShrink={0} fg={th.text.muted}>
        {age(props.store.now() - props.row.lastSeen).padStart(3)}
      </text>
      <Show when={props.wide}>
        <text flexShrink={0} fg={th.text.faint} wrapMode="none" truncate>
          {context.ui.format.path(props.row.directory)}
        </text>
      </Show>
    </box>
  )
}

function SidebarMesh(props: { store: MeshStore; sessionID: string }) {
  const context = usePlugin()
  const th = context.theme
  const [me] = createResource(
    () => [props.sessionID, props.store.view.supervisor?.sessionID] as const,
    async ([sessionID]): Promise<Whoami | undefined> => props.store.rpc().whoami({ sessionID }).catch(() => undefined),
  )
  const isSupervisor = () => me()?.role === "supervisor"

  return (
    <box>
      <Show when={me()} fallback={<text fg={th.text.muted}>MESH …</text>}>
        {(who: () => Whoami) => (
          <>
            <text fg={th.text.base} wrapMode="none" truncate>
              <b>MESH</b>
              <span style={{ fg: th.text.muted }}>
                {" "}
                {who().role === "supervisor" ? `supervisor · ${who().host}` : who().role === "worker" ? `worker · ${who().host}/${who().name}` : "not a mesh session · /super"}
              </span>
            </text>

            <Show when={isSupervisor()}>
              <Show when={props.store.sorted().length > 0} fallback={<text fg={th.text.faint}>no workers</text>}>
                <For each={props.store.sorted()}>{(row) => <Row store={props.store} row={row} onPick={() => void openWorker(context, props.store, row)} />}</For>
                <text fg={th.text.faint}>{summary(props.store.tally())}</text>
              </Show>
            </Show>

            <Show when={who().role === "worker"}>
              <WorkerIdentity store={props.store} who={who()} />
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}

function WorkerIdentity(props: { store: MeshStore; who: Whoami }) {
  const context = usePlugin()
  const th = context.theme
  const status = () => context.data.session.status(props.who.sessionID)
  return (
    <>
      <text fg={th.text.muted}>
        supervisor <span style={{ fg: th.text.base }}>{props.who.supervisor ? `${props.who.supervisor.host}/${short(props.who.supervisor.sessionID, 12)}` : "—"}</span>
      </text>
      <text fg={th.text.muted}>
        state <span style={{ fg: status() === "running" ? th.text.action.primary.base : th.text.muted }}>{status() === "running" ? "busy" : "idle"}</span>
      </text>
    </>
  )
}

function FooterStatus(props: { store: MeshStore }) {
  const context = usePlugin()
  const th = context.theme
  const visible = () => props.store.view.supervisor?.host === props.store.view.host && props.store.view.host !== undefined
  return (
    <Show when={visible()}>
      <text fg={props.store.tally().bad ? th.text.feedback.error.base : th.text.muted} onMouseUp={() => void context.ui.panel.open(PANEL)}>
        {footer(props.store.tally())}
      </text>
    </Show>
  )
}

function RosterPanel(props: { store: MeshStore; panel: PanelInput }) {
  const context = usePlugin()
  const th = context.theme
  const [index, setIndex] = createSignal(0)
  const rows = () => props.store.sorted()
  const selected = () => rows()[Math.min(index(), Math.max(0, rows().length - 1))]
  const [preview, { refetch }] = createResource(
    () => selected() && ([selected()!.host, selected()!.sessionID, selected()!.state] as const),
    async ([host, sessionID]) => {
      try {
        return (await props.store.rpc().read({ host, sessionID, tail: 30 })).text
      } catch (e) {
        return `transcript unavailable: ${(e as { message?: string })?.message ?? String(e)}`
      }
    },
  )
  const move = (d: number) => setIndex((i) => Math.max(0, Math.min(rows().length - 1, i + d)))

  context.keymap.layer(() => ({
    commands: [
      { bind: "up", title: "Previous worker", group: "Mesh", run: () => move(-1) },
      { bind: "k", title: "Previous worker", group: "Mesh", run: () => move(-1) },
      { bind: "down", title: "Next worker", group: "Mesh", run: () => move(1) },
      { bind: "j", title: "Next worker", group: "Mesh", run: () => move(1) },
      { bind: "return", title: "Open worker", group: "Mesh", run: () => void (selected() && openWorker(context, props.store, selected()!)) },
      { bind: "r", title: "Refresh roster", group: "Mesh", run: () => void props.store.load(true).then(() => refetch()) },
      { bind: "f", title: "Toggle fullscreen", group: "Mesh", run: props.panel.toggleFullscreen },
      { bind: "escape", title: "Close", group: "Mesh", run: props.panel.close },
    ],
  }))

  return (
    <box width="100%" height="100%" flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
      <box flexDirection="row" gap={1} flexShrink={0} minWidth={0}>
        <text fg={th.text.base} flexShrink={0}>
          <b>MESH</b>
        </text>
        <text fg={th.text.muted} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate>
          {props.store.view.supervisor ? `supervisor ${props.store.view.supervisor.host}/${short(props.store.view.supervisor.sessionID, 12)}` : "no supervisor on this host"}
        </text>
      </box>
      <text fg={th.text.faint} flexShrink={0} wrapMode="none" truncate>
        ↑↓ select · enter open · r refresh · f full · esc close
      </text>
      <Show when={props.store.view.error}>
        <text fg={th.text.feedback.error.base}>{props.store.view.error}</text>
      </Show>
      <box flexDirection="column" flexShrink={0} paddingTop={1}>
        <Show when={rows().length > 0} fallback={<text fg={th.text.faint}>no workers</text>}>
          <For each={rows()}>
            {(row, i) => <Row store={props.store} row={row} wide selected={i() === index()} onPick={() => (i() === index() ? void openWorker(context, props.store, row) : setIndex(i()))} />}
          </For>
        </Show>
        <text fg={th.text.faint}>{summary(props.store.tally())}</text>
      </box>
      <Show when={selected()}>
        {(row: () => RosterRow) => (
          <box flexDirection="column" flexGrow={1} minHeight={0} paddingTop={1}>
            <text fg={th.text.muted} wrapMode="none" truncate>
              {row().host}/{row().name} · <span style={{ fg: th.text.faint }}>{row().sessionID}</span>
            </text>
            <scrollbox flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom">
              <text fg={th.text.base} wrapMode="word">
                {preview.loading ? "loading…" : (preview() ?? "")}
              </text>
            </scrollbox>
          </box>
        )}
      </Show>
    </box>
  )
}

function Commands(props: { store: MeshStore }) {
  const context = usePlugin()
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "mesh.roster",
        title: "Mesh roster",
        description: "Workers supervised from this host",
        group: "Mesh",
        palette: true,
        // No default key: ctrl+m is carriage return in most terminals and would shadow Enter.
        slash: { name: "mesh" },
        run: () => {
          const current = context.ui.panel.current()
          if (current?.name === PANEL) return context.ui.panel.close()
          if (!context.ui.panel.open(PANEL)) context.ui.toast.show({ title: "mesh", message: footer(props.store.tally()) + " — open a session to see the panel" })
        },
      },
      {
        id: "mesh.refresh",
        title: "Mesh: refresh roster",
        group: "Mesh",
        palette: true,
        run: () => void props.store.load(true),
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "madcat.tui",
  setup(context) {
    const { store, dispose } = createRoot((disposeRoot) => {
      const store = createMeshStore(context)
      return {
        store,
        dispose: () => {
          store.dispose()
          disposeRoot()
        },
      }
    })

    context.ui.slot({ append: "app", render: () => <Commands store={store} /> })
    context.ui.slot({ append: "sidebar.content", render: (input) => <SidebarMesh store={store} sessionID={input.sessionID} /> })
    context.ui.slot({ append: "home.footer.status", render: () => <FooterStatus store={store} /> })
    context.ui.slot({ append: "prompt.footer.status", render: () => <FooterStatus store={store} /> })
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <RosterPanel store={store} panel={panel} />
        </Show>
      ),
    })

    return dispose
  },
})
