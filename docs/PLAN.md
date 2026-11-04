# opencode-madcat — Mesh steering plan

Status: **planning only**. Nothing here is implemented. Last revised 2026-11-04.

## Goal

An OpenCode V2 plugin that lets any OpenCode session steer sessions on any
other host in the MADCAT mesh, supervisor/worker style: spawn a worker over
there, give it standing orders, watch it, interrupt it, collect its report.

## Decisions taken

| Decision | Choice | Consequence |
|---|---|---|
| Topology | **Any-to-any mesh** | Every host is both a potential supervisor and worker. No special "hub" role; roles are per-session, not per-host. |
| Host config | **`~/.config/madcat/config.toml` `[mesh.*]`** | `url` + `password` per host. Nothing checked in. |
| Durable state | **Postgres (shared EEMS DB)** | One roster/inbox/assignment view across all hosts. Survives restarts. The DB is the source of truth; OpenCode sessions are the execution substrate. |
| Worker plugin | **Required on every host** | Can assume the `mesh` RPC exists on every peer. Single code path, single version. |

## Mental model

```
                      ┌──────────────── Postgres (shared) ────────────────┐
                      │ mesh_hosts · mesh_sessions · mesh_assignments     │
                      │ mesh_messages · mesh_events                       │
                      └──▲──────────────▲──────────────▲──────────────────┘
                         │              │              │
            ┌────────────┴──┐   ┌───────┴───────┐   ┌──┴────────────┐
            │ fuji          │   │ sin           │   │ junkpile      │
            │ serve+plugin  │◀─▶│ serve+plugin  │◀─▶│ serve+plugin  │
            │ sessions …    │   │ sessions …    │   │ sessions …    │
            └───────────────┘   └───────────────┘   └───────────────┘
                   HTTP Basic + SSE between every pair (session API + mesh RPC)
```

Three planes:

1. **Control plane — Postgres.** Who exists, who supervises whom, what was
   assigned, what was said. Every host reads and writes it.
2. **Steering plane — OpenCode session API over HTTP.** `prompt`, `synthetic`,
   `instructions.entry`, `interrupt`, `wait`, `context` against a remote host
   via `@opencode/client`. Local targets go through `ctx.session` directly.
3. **Observation plane — SSE event stream per peer.** Each host subscribes to
   every other host's `event.subscribe()` and mirrors the interesting events
   (`session.idle`, `session.error`, `session.tool.*`, `session.updated`)
   into `mesh_events` so a supervisor on any host can react.

## Identity: what is a "mesh session"?

A session becomes mesh-visible when the plugin **registers** it in
`mesh_sessions`:

```
mesh_sessions
  id            text  pk   -- "<host>/<sessionID>"
  host          text       -- mesh host name from config
  session_id    text       -- OpenCode session id
  role          text       -- supervisor | worker | observer
  name          text       -- human/agent-friendly alias, unique per host
  supervisor    text  fk   -- mesh_sessions.id of the session steering this one (nullable)
  directory     text
  agent         text
  state         text       -- spawning | idle | busy | error | done | lost
  created_at, updated_at, last_seen
```

- `name` is the addressing surface for agents (`mesh_send to: "sin/reviewer"`).
  This solves the "address by title is spoofable" problem from #58367: names
  live in our DB, not in OpenCode titles.
- `supervisor` is the only authorization edge. A session may steer another
  session iff it is that session's `supervisor` (or an ancestor in that chain).
  Any-to-any at the **host** level; parent-child at the **session** level.
- `state` is driven from the observation plane; `last_seen` from the event
  stream heartbeat. A peer that stops sending events flips its sessions to
  `lost` after a timeout — no auto-restart (prior-art lesson).

## Transport: `Mesh` client registry

```ts
interface Peer {
  name: string            // "fuji"
  url: string             // "http://fuji.lan:4096"
  client: OpenCode        // @opencode/client with Basic auth headers
  self: boolean           // this host — route via ctx.session instead
}
```

Built once at `setup()` from `[mesh.*]`. A unified `Steer` facade takes
`(target: MeshSessionID, …)` and dispatches to `ctx.session.*` when
`peer.self`, otherwise `peer.client.session.*`. Both expose the same method
names per the docs, so the facade is a thin switch.

## Steering primitives (facade over session API)

| Primitive | Backing call | Notes |
|---|---|---|
| `spawn(host, { name, agent, directory, orders })` | `session.create` → register in DB → `instructions.entry.put(orders)` → `prompt(initial)` | Fire-and-forget. Returns mesh id immediately. |
| `send(target, text, { delivery })` | `session.prompt({ delivery: "steer" \| "queue", id, metadata })` | `id` = ULID stored in `mesh_messages` → idempotent retries. `metadata.mesh = { from, msgID }`. |
| `note(target, text)` | `session.synthetic` | Inject without triggering a turn. |
| `orders(target, key, value)` | `session.instructions.entry.put` | Standing orders; announced at next step boundary, no turn consumed. |
| `interrupt(target, { resume })` | `session.interrupt` | |
| `wait(target)` | `session.wait` | Remote: long HTTP call; set generous `AbortSignal.timeout`. |
| `read(target, { tail })` | `session.context` | Supervisor reads worker transcript. |
| `remove(target)` | `session.remove` | Also marks `done` in DB. |

## Messaging and reporting

Every message is written to `mesh_messages` **first**, then delivered via
`send`. The DB row is the audit log; delivery is best-effort with retry on the
stored `id`. This is the "inbox as source of truth, session injection as
delivery" pattern from the Agent Teams port, lifted into Postgres.

```
mesh_messages
  id          text pk   -- ULID, also the prompt `id` sent to OpenCode
  from_id     text fk mesh_sessions
  to_id       text fk mesh_sessions
  kind        text      -- order | report | ask | reply | system
  body        text
  delivery    text      -- steer | queue
  status      text      -- pending | delivered | failed
  created_at, delivered_at
```

Workers report with `mesh_report`, which is `send(supervisor, text, { kind:
"report", delivery: "steer" })`. If the supervisor is idle, the prompt starts a
turn — that is the auto-wake.

### Trust

A plugin cannot attest sender identity (#58367). Mitigations:

- Delivered prompts carry `metadata.mesh.msgID`; the receiving plugin's
  `session.hook("prompt")` looks the id up in `mesh_messages` and **only then**
  prefixes the text with a trusted `[mesh from <name>]` banner. Prompts without
  a matching row get no banner and are treated as plain user input.
- Nothing privileged happens as a side effect of receiving a message. Steering
  calls are made by the supervisor's tools, authorized by the `supervisor` edge
  in the DB.

## Observation plane

Per peer, one long-lived `client.event.subscribe({ types: [...] })` loop:

- On `server.connected` → re-`session.list` that host and reconcile
  `mesh_sessions.state`.
- Map events → `mesh_events` rows + `mesh_sessions.state` transitions.
- No replay in the SSE stream, so reconciliation on reconnect is mandatory.
- Backoff reconnect; after N failures mark that peer's sessions `lost`.

A supervisor learns about its workers either by being woken via `mesh_report`
(push) or by `mesh_status` (pull from DB). No polling of the remote session API
in the hot path.

## Agent-facing tools (`ctx.tool.transform`, namespace `mesh`)

| Tool | Who sees it | Does |
|---|---|---|
| `mesh_hosts` | all | list peers + reachability |
| `mesh_sessions` | all | roster from DB, filter by host/role/state |
| `mesh_spawn` | supervisor-capable | create worker on a host |
| `mesh_send` | supervisor of target | order / ask |
| `mesh_orders` | supervisor of target | put/remove standing orders |
| `mesh_read` | supervisor of target | tail transcript |
| `mesh_interrupt` | supervisor of target | |
| `mesh_wait` | supervisor of target | |
| `mesh_remove` | supervisor of target | |
| `mesh_report` | worker | report to own supervisor |
| `mesh_ask` | worker | ask supervisor, `delivery: steer` |
| `mesh_whoami` | all | own mesh id, role, supervisor, host |

Tool context includes the calling `sessionID`; combined with the DB that's
enough to authorize every call. Mesh tools are **denied on `task` subagents**
so disposable explorers can't flood the channel.

## RPC (`ctx.rpc.register`, id `mesh`)

Since the plugin is on every host, peers can also talk plugin-to-plugin:

- `mesh.hello()` → `{ host, version, sessions: n }` — handshake / version check
  at startup; mismatched versions are logged loudly.
- `mesh.register(sessionID, role, name)` — remote-side registration when a
  supervisor spawns a worker (so the worker host's plugin knows its role
  without a DB round trip).
- events: `mesh.session.changed` for TUI/GUI parts later.

## Config

```toml
# ~/.config/madcat/config.toml
[mesh]
self = "fuji"                      # which [mesh.<name>] is this host

[mesh.fuji]
url = "http://fuji.lan:49374"
password = "…"

[mesh.sin]
url = "http://sin.lan:49374"
password = "…"

[database]
dsn = "postgres://…"               # mesh_* tables live here
```

Each host runs `opencode service set hostname 0.0.0.0` (or `serve --hostname
0.0.0.0` under systemd) with a fixed `OPENCODE_PASSWORD`.

## Open questions

1. **Postgres schema ownership** — new `mesh_*` tables in the EEMS database, or
   a separate database on the same server? Separate keeps the memory store's
   per-user scoping untouched.
2. **Who creates the schema** — idempotent `CREATE TABLE IF NOT EXISTS` at
   plugin init (like the old `eems_init.sql`), or a migration step?
3. **Multi-supervisor** — can a session have more than one supervisor, or is
   the chain strictly a tree? Tree is simpler to authorize.
4. **Cross-directory workers** — spawn always needs a `directory` on the remote
   host. Config a default per host, or require it per spawn?
5. **TUI part** — a sidebar listing mesh sessions is cheap once the RPC events
   exist. Scope for v1 or later?
6. **Effect vs Promise API** — the Effect plugin API would make the event loops
   and retries cleaner, at the cost of a learning curve. Decide before writing
   the observation plane.

## Phases (proposed)

1. **Skeleton** — package, `Plugin.define`, config loading, `Mesh` registry,
   `mesh.hello` RPC, `mesh_hosts` tool. Proves cross-host auth works.
2. **Roster** — Postgres schema, `mesh_whoami`, `mesh_sessions`, registration
   on `session.created`.
3. **Steering** — `spawn`, `send`, `orders`, `interrupt`, `wait`, `read`,
   `remove` + their tools, local and remote.
4. **Observation** — per-peer event loops, state transitions, `lost`
   detection, reconnect reconciliation.
5. **Reporting + trust** — `mesh_report` / `mesh_ask`, `prompt` hook banner,
   subagent deny rules.
6. **TUI** — optional sidebar.

## References

- `docs/plugins-server.md` — `ctx.session`, `ctx.tool.transform`,
  `ctx.event.subscribe`, `session.hook("prompt")`
- `docs/plugins-rpc.md` — `Rpc.define` / `ctx.rpc.register`
- `docs/client-javascript.md` — `OpenCode.make`, `event.subscribe`, remote RPC
- `docs/cli-web.md` — exposing a server, Basic auth, `OPENCODE_PASSWORD`
- `docs/openapi.json` — `/api/session/{id}/prompt` body: `text, delivery, id,
  metadata, agents, skills, files, resume`
- `docs/PRIOR-ART.md` — survey of existing session-orchestration plugins
