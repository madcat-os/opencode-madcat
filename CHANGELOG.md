# Changelog

All notable changes to `@madcat-os/opencode-madcat` (formerly `@madcat-os/opencode-plugin`) are documented here.

## Unreleased — tool surface trimmed

### Removed

- `latex_render`, `geo_*` (search, reverse), `brave_search`, `workspace_*`,
  `worktree_*`, `file_*` and `find_*` tool namespaces. `BRAVE_API_KEY` and
  `TECTONIC_PATH` are no longer read.
- `tts_*` (speak, list, active, switch_voice, health) and the local playback
  helper `src/lib/audio.ts`. `[tts]`, `MADCAT_TTS_URL`, `MADCAT_TTS_AUTH` and
  `MADCAT_TTS_TOKEN` are no longer read. `~/.local/share/madcat/tts-state.toml`
  is still read for the active persona cart.
- `index_*` (code, docs, search, status, clear), `ingest_*` (html, pdf,
  json_docs) and `code_screenshot`, with `CodeIndex` in `lib/eems.ts`,
  `lib/chunk.ts`, `lib/walk.ts`, `lib/silicon.ts` and `src/assets/`. The
  `chunks_code`, `chunks_docs` and `file_state` tables are no longer created;
  existing ones are left in place. Drops the `shiki`, `@resvg/resvg-wasm`,
  `@firecrawl/pdf-inspector` and `@kreuzberg/html-to-markdown-node`
  dependencies.

- `audio_*` (concat, convert, effects, mix, normalize, probe, silence, split,
  trim, waveform), `cart_*` (info, list, load), `icons_*` (categories,
  download, search), `kindle_*` (newspaper, newspaper_current,
  newspaper_next, send_content), `signal_*` (send, voice) and `whatsapp_*`
  (presence, send, send_location, voice) tool namespaces, with the
  `skills/kindle` and `skills/newspaper` scripts the kindle tools drove.
  `[signal]` / `[whatsapp]` in `config.toml` are no longer read. Any
  `[mcp].disabled_tools` entry naming them is now a no-op.
- Persona cart resolution in `hooks/persona.ts` and `whoami_info` is
  unchanged; only the cart management tools are gone.

## 2.9.0 — legacy memory tools removed

### Removed

- `legacy_memory_recall`, `legacy_memory_search`, `legacy_memory_list` and
  `legacy_memory_core` (`src/tools/legacy-memory.ts`). They shelled out to
  `madcat memory … --json`, a subcommand the `madcat` CLI no longer has (5.x
  ships only `mcp` and `claude`), so every call failed with a bare "Command
  failed". EEMS (`memory_*`) is the memory store. Any `[mcp].disabled_tools`
  entry naming them is now a no-op.

## 2.8.0 — job search removed; releases cut from tags

### Removed

- `jobs_search` and `jobs_providers` tools (`src/tools/jobs.ts`) and the Firefox
  cookie reader they depended on (`src/lib/firefox.ts`). The WAAS provider read
  the workatastartup.com SSO cookie straight out of the local Firefox profile's
  `cookies.sqlite`; the HN, Just Join IT and NoFluffJobs providers go with it.
  Any `[mcp].disabled_tools` entry naming them is now a no-op.

### Changed

- Release workflow runs only on pushed tags `v*`, no longer on every push to
  `master`/`v2.0`. It fails if the tag does not match `package.json`'s version;
  `vX.Y.Z` publishes as `latest`, a hyphenated prerelease as `next`.

## 2.7.0 — the sign-in is the database credential

### Changed

- EEMS access is now OAuth-scoped. madcat-web provisions each user a Postgres
  role that owns only `{db_name}_eems` and returns its connection string as
  `db_url` from `/api/me`; `principal.ts` connects with that instead of
  `[database].dsn` with the database name swapped. The client no longer holds
  a shared credential that can reach another user's data. When the server
  returns no `db_url` the old derived DSN is still used; `whoami_info.eems`
  reports `role` and `access: "scoped" | "derived"` so the difference is
  visible. The readiness probe connects as the user (not the base role), so a
  bad credential or revoked CONNECT surfaces at resolution time with the
  database and role named.
- Hosts with no menubar session file at all (headless serves) fall back to the
  global `[database].dsn`; `whoami_info.eems.mode` is `"shared"`. A session
  file that exists but is expired, rejected or unresolvable still throws with a
  sign-in instruction — memories are never silently written to the shared
  store on a host where someone signed in.
- AGENTS.md install docs updated for the v2.2 CLI (`opencode plugin add` /
  `update` / `list`).

## 2.6.1 — TTS requests carry the menubar session

### Fixed

- `tts_*` tools returned `HTTP 401: unauthorized` against a daemon configured
  with `[tts].auth = "oauth"`: `ttsRequest` sent no credentials. It now attaches
  the signed-in principal's madcat-web desktop session as `Authorization: Bearer`
  — the same token EEMS uses to select the user's database — re-read per request
  so a re-sign-in takes effect without a restart. `MADCAT_TTS_TOKEN` overrides
  for headless hosts without a menubar; `MADCAT_TTS_AUTH` overrides the config
  key. With no valid session the tool reports the sign-in instruction instead of
  a bare 401. `auth = "none"` (default) is unchanged.

## 2.6.0 — public on npmjs as `@madcat-os/opencode-madcat`

### Changed

- Package renamed from `@madcat-os/opencode-plugin` to `@madcat-os/opencode-madcat`,
  source moved to `github.com/madcat-os/opencode-madcat`, published publicly to
  npmjs from GitHub Actions. Install with
  `opencode plugin '@madcat-os/opencode-madcat@X.Y.Z'`.
- Kindle and newspaper skills read sender/recipient identity from the
  environment (`MADCAT_MAIL_SENDER`, `MADCAT_MAIL_ACCOUNT`, `MADCAT_KINDLE_EMAIL`,
  `MADCAT_MAIL_DISPLAY`, `MADCAT_NEWSPAPER_AUTHOR`) instead of hardcoded
  addresses, and fail with a clear error when unset. `newspaper.sh` now sources
  `opencode-serve.env` like `kindle.sh` does.
- `geo_*` User-Agent names the npm package instead of an operator email.

### Removed

- `src/lib/hosts.json` — a static mesh host list with a plaintext serve
  password. Nothing imported it; `[mesh.*]` in config.toml has been the source
  for host credentials since 0.20. **The password it contained should be
  rotated**: it has been in git history on the private remote.

## 2.5.0 — code screenshots without the NAPI binding; no binaries left

### Changed

- `code_screenshot` renders with shiki (346 TextMate grammars, 65 VS Code
  themes) → SVG window frame → `@resvg/resvg-wasm` with the bundled
  `src/assets/Hack-Regular.ttf` (`src/lib/silicon.ts`). Layout — 26px mono on
  32px lines, 40px titlebar with traffic lights, rounded window on a dark mat —
  matches the former syntect/image renderer. Default theme is `github-dark`;
  the old syntect names (`base16-ocean.dark`, `base16-ocean.light`,
  `base16-eighties.dark`, `base16-mocha.dark`, `InspiredGitHub`,
  `Solarized (dark|light)`) map to the nearest shiki theme. Unknown themes
  return an error listing the available ones. Works on linux-arm64 (sin) for
  the first time.

### Removed

- `madcat-silicon.{darwin-arm64,linux-x64-gnu}.node` and
  `src/lib/silicon-native.ts`. The package ships no `.node` binaries.

### Added

- Dependencies `shiki` and `@resvg/resvg-wasm`.

## 2.4.0 — audio playback without the NAPI binding

### Changed

- Local audio playback (`src/lib/audio.ts`) spawns the platform player —
  `afplay` on macOS, `pw-play` / `paplay` / `aplay` on Linux — instead of the
  madcat-audio NAPI binding. Each player process is tracked: `stopAll()` and
  `isPlaying()` are real, and `tts_speak` clears the ear mute flag when the
  clip actually ends (`proc.exited` + tail) in both `wait` modes. The ffprobe
  duration guess for fire-and-forget playback is gone. `tts_speak` reports
  `backend` as the player name (`afplay`, `pw-play`, …) or `none`.

### Removed

- `madcat-audio.{darwin-arm64,linux-x64-gnu}.node` and
  `src/lib/audio-native.ts`. `madcat-silicon` remains for now.

## 2.3.0 — EEMS in TypeScript, routed to the signed-in user's database

### Changed

- EEMS memory and the code/docs index are pure TypeScript (`src/lib/eems.ts`,
  `embed.ts`, `chunk.ts`, `walk.ts`, schema in `src/lib/sql/eems_init.sql`) on
  the `postgres` package. The SQL — pgvector cosine + tsvector `ts_rank`,
  RRF-fused in one round trip — is the same the Rust crate ran; chunking
  heuristics, walker filters and dedup-by-content-hash are ported line for line.
  Every store/index method is now `async`; the NAPI calls blocked the Bun event
  loop on each Postgres and embedding round trip.
- Memory, index and the doctrine mirror land in the **signed-in user's
  instanced database**. `src/lib/principal.ts` reads the Madcat menubar's
  desktop session (`~/Library/Application Support/Madcat/session-<host>.json`,
  `$XDG_DATA_HOME/Madcat/` on Linux), resolves it at `{web}/api/me` and derives
  `{db_name}_{db}` on the `[database].dsn` server (or `[database].user_dsn` with
  `{db_name}` filled in) — the same rule the madcat server applies to OAuth
  callers. The token only selects the database; Postgres credentials still come
  from `[database].dsn`. Without a valid sign-in (no session file, expired, 401,
  madcat-web unreachable) or when the instanced database does not exist, memory
  and index tools **fail with a sign-in instruction** — there is no fallback to
  the shared base database. Dual-DSN mode (`EEMS_DSN_CORE` + `EEMS_DSN_DOUBLE`)
  still takes precedence and bypasses principal resolution.
- `whoami_info` reports an `eems` block: `mode` (`principal` | `dual-dsn` |
  `unavailable`), user, database, session expiry, or the failure reason.
- `embeddingConfig()` in `src/lib/config.ts` reads the full `[embedding]`
  block (`provider`, `url`, `model`, `dimensions`, `api_key` with
  `OPENAI_API_KEY` fallback), replacing the stale `embedUrl()` default.
  `webUrl()` reads `MADCAT_WEB_URL` / `[web].url` / `[mcp].oauth_issuer`
  (default `https://madcat-os.com`); `eemsUserDsn()` reads `[database].user_dsn`.
- `sessions_ingest` detects dedup hits by ULID age instead of catching the
  SQLite "UNIQUE constraint" message.
- `tools/memory.ts` and `tools/indexer.ts` are static imports again; the
  `tryImport` guard existed only for the NAPI loader.

### Removed

- `madcat-memory.{darwin-arm64,linux-arm64-gnu,linux-x64-gnu}.node` (~25 MB).
  `madcat-audio` and `madcat-silicon` binaries remain for now.

## 2.2.0 — drop macOS automation and plugin-side compaction

### Removed

- All 17 `macos_*` tools (`src/tools/macos.ts`), the osascript/TCC helpers
  (`src/lib/macos.ts`), the native clipboard loader (`src/lib/macos-native.ts`)
  and its `madcat-macos.darwin-arm64.node` binary, the Rust crate source
  (`crates/madcat-macos/`), and the AppleScript/JXA script library
  (`skills/macos/`). The 0.20.0 macOS surface is gone entirely; nothing in the
  plugin is darwin-only anymore.
- Plugin-side auto-compaction (`src/hooks/compaction.ts`, the
  `[compaction]` config.toml section and `compactionConfig()` getter). The hook
  fired `session.compact()` at a fixed 200k-token threshold, which is wrong for
  both small and large context windows. opencode V2 compacts on its own, scaled
  to the model's window — tune `compaction.auto` / `compaction.buffer` /
  `agents.compaction.model` in `opencode.jsonc` instead.

## 2.1.0 — drop Gitea and Coolify tool namespaces

### Removed

- `gitea_*` and `coolify_*` tools (`src/tools/gitea.ts`, `src/tools/coolify.ts`)
  and their `giteaBaseUrl()` / `coolifyBaseUrl()` config getters. The `[gitea]`
  and `[coolify]` sections of config.toml and the `GITEA_BASE_URL` /
  `COOLIFY_BASE_URL` env vars are no longer read.

## 2.0.0 — opencode V2 client + event shapes

Completes the V2 port: the mesh-facing tools now talk to remote serves through
the V2 HTTP client, and the event hooks read V2 event payloads. Verified live
against an `opencode serve` 2.0.30 instance.

### Changed

- **Client** — `@opencode-ai/sdk` (V1) → `@opencode/client@^2.0.26`.
  `sdk(host)` in `src/lib/sdk.ts` returns `OpenCode.make({ baseUrl, headers })`
  with Basic auth from `[mesh.*]`; a trailing `/api` on the configured URL is
  stripped (the V2 client adds it). V2 calls resolve to the body directly and
  throw on error, so `unwrap()` is gone; `run()` remains. New `projectId(host,
  directory?)` helper resolves a project via `location.get`.
- **Event hooks** — V2 events carry `data`, not `properties`. `idle.ts` reads
  `event.data.sessionID`. Auto-compaction now listens to `session.step.ended`
  (`message.updated` no longer exists) and counts `tokens.input +
  tokens.cache.read` toward the threshold.
- **sessions_*** — `status` merges `session.active()` with `session.list()`
  (non-active = idle); `children` uses `session.list({ parentID })`; `list`
  gains `search`/`directory`/`cursor` and returns a `cursor`.
- **control_*** — `abort` → `session.interrupt`; `summarize` → `session.compact`
  (model resolved server-side; `queue` flag replaces provider/model);
  `delete` → `session.remove`; `revert`/`unrevert` → `session.revert.stage` /
  `.clear`; `slash` → `session.command`; `create` accepts `agent`, `model`
  (`provider/model[#variant]`), `directory`.
- **messages_*** — `read` uses `message.list` (typed V2 messages; `cursor.next`
  pagination); `prompt` sends, then `session.wait`s and returns the last
  assistant message; `prompt_async` reports `dispatched`/`queued` from
  `session.active()` and supports `queue` delivery. Both accept `agent`/`model`
  overrides applied via `session.switchAgent`/`switchModel`.
- **worktree_*** — `/experimental/worktree` → `worktree.list/create/remove/refresh`
  (project-scoped; `directory` arg resolves the project).
- **file_*** — `read` decodes the V2 `Uint8Array` body; `status` → `vcs.status`.
  All take an optional `directory` location.
- **find_files** → `file.find({ query, limit, type })`. **find_text** now shells
  out to `rg` (fallback `grep -rnI`) on the host — V2 has no text-search endpoint.
- **server_*** — `health` → `server.info` + `location.get`; `agents`/`commands`/
  `providers`/`plugins` → V2 lists. New `server_models` (`model.list` + default).
- **pty_*** — `ptyID` inputs; results unwrapped from `{ location, data }`.
- **auth_*** — `set` → `integration.connect.key`; `remove` → `credential.list` +
  `credential.remove` (accepts credential ID or integration ID). New `auth_list`.
- **infra_*** — `mcp_add` takes `command[]` or `url`/`headers`; `mcp_remove`
  added; `mcp_connect`/`mcp_disconnect` use `{ server }`. New `infra_skills`.
- **tools_ids** / **tools_schemas** — no V2 HTTP endpoint for the tool registry;
  they now introspect this host's `ctx.tool.list()` (no `host` arg).
- **workspace_*** — `path` → `location.get`; `vcs` → `vcs.get` + `vcs.status`.
  New `workspace_projects`.
- **ToolContext** gains an optional `abort` signal (used by `messages_prompt`).

### Removed

- `instance_dispose`, `sessions_todo`, `find_symbols`, `infra_formatters`,
  `infra_lsp`, `worktree_reset` — no V2 equivalents.
- `@opencode-ai/sdk` dependency.

## 1.0.0 — opencode V2 plugin API

Ports the entire plugin to the opencode **V2 plugin API** (`@opencode/plugin`).
V1 plugin implementations do not run under opencode V2; this release is the
V2-compatible line. Requires opencode **>= 2.0** (dropped V1 support).

### Changed

- **Entrypoint** — `src/index.ts` now default-exports `Plugin.define({ id, setup })`
  instead of the V1 plugin function. Plugin `id` is `"madcat"` (scopes storage
  and identifies the plugin in status/diagnostics).
- **Package** — dependency `@opencode-ai/plugin` → `@opencode/plugin@^2.0.26`;
  added explicit `zod@^4.1.8`. Removed the V1 `oc-plugin` marker and the
  `./server` export; a single default export remains.
- **Tool registration** — all ~160 tools now register through
  `ctx.tool.transform(editor => editor.add(...))`. V1 string returns are
  normalized to V2 `{ content }` results by an adapter in `index.ts`.
- **Hooks → V2 domains:**
  - persona + doctrine injection moved from `experimental.chat.system.transform`
    to `ctx.session.hook("context", ...)`, pushing `SystemPart` objects
    (`{ type: "text", text }`) onto `event.system`. Both now read the agent
    directly off the context event (no session lookup for the agent).
  - idle + auto-compaction moved from the V1 `event` hook to
    `ctx.event.subscribe()`, aborted via the cleanup function returned by `setup`.
  - auto-compaction now calls `ctx.session.compact({ sessionID })`
    (replaces `client.session.summarize`); the summarization model is resolved
    server-side, so `[compaction] provider/model` config is no longer sent.

### Added

- **`src/lib/tool.ts`** — a local, V1-compatible `tool()` helper (with
  `tool.schema = zod`). Tool modules keep their existing authoring shape; only
  their import line changed (`@opencode-ai/plugin` → `../lib/tool`). The V2
  editor accepts the Zod object as a StandardSchema `input` directly.

### Removed

- **TUI toasts** — the V2 plugin context has no TUI surface. The idle and
  auto-compaction toasts are replaced with structured `console.log` lines
  captured by the opencode runtime.

### Notes

- Cross-host mesh tools still use the standalone `@opencode-ai/sdk` client over
  HTTP (`src/lib/sdk.ts`) — independent of the plugin runtime, unaffected by V2.
- Tool `execute` receives the V2 `ToolContext`; `directory`/`worktree` (which
  moved to `ctx.location` in V2) are injected back into the V1-shaped context so
  tools like `whoami`/`prime` keep working unchanged.

## 0.20.0 — macOS automation surface

Full macOS automation, landed across five chunks (epic #48). Adds 17 new
`macos_*` tools, an external AppleScript/JXA script library, a native clipboard
NAPI module, and TCC-gated screen/input tools with graceful degradation.

### Added

- **osascript tool layer** (Chunk 1) — 14 first-class `macos_*` tools driving
  the macOS app graph via AppleScript/JXA and shell one-shots:
  `macos_calendar_event`, `macos_reminder`, `macos_mail_draft`,
  `macos_mail_send`, `macos_notes`, `macos_messages_send`, `macos_notify`,
  `macos_say`, `macos_open`, `macos_shortcut`, `macos_safari`, `macos_finder`,
  `macos_system`, `macos_clipboard`. Values are passed as `on run argv` — never
  string-interpolated — eliminating AppleScript quoting/escaping hazards.
- **External script library** (Chunk 2) — 23 versioned AppleScript files under
  `skills/macos/scripts/` plus `SKILL.md`, invoked from TypeScript via
  `runScript(name, args[])` (`src/lib/macos.ts`). Extracted from Chunk 1's inline
  heredocs — same behavior, now maintainable, testable, and reusable. Scripts
  resolve module-relative so they work in-repo and inside the installed npm
  package.
- **Native clipboard NAPI** (Chunk 3) — `madcat-macos.darwin-arm64.node`
  (darwin-arm64-only Rust crate) wrapped by `src/lib/macos-native.ts`. Exposes
  read/write text, raw-data-by-UTI, flavor enumeration, and a monotonic
  `changeCount`. `macos_clipboard` uses the native binding when present and
  falls back to `pbcopy`/`pbpaste` when it is absent — the linux mesh nodes and
  any binary-less install keep working.
- **TCC-gated tools** (Chunk 4) — `macos_screenshot` (Screen Recording),
  `macos_input` (Accessibility), and `macos_capabilities` (read-only diagnostic
  probing both grants). These are deferred hooks: interfaces exist and
  self-detect the TCC grant via `checkTCC(service)`, degrading gracefully with an
  actionable `{ ok:false, granted:false, message, steps }` payload rather than
  blocking, hanging, or throwing when a grant is absent. They auto-unblock once
  the stable-signed-binary hardening (#44) lands — no code change required.

### Changed

- `AGENTS.md` — tool inventory updated (~120 → ~137 tools), NAPI binary table
  now lists `madcat-macos`, structure reflects the `macos.ts` tool file and
  `macos-native.ts` loader, and `skills/` documents the `macos/` skill.

### Notes

- The Rust crate source (`crates/madcat-macos/`) is build-time only and does not
  ship in the npm package — the prebuilt `.node` is the shipped artifact.
- Grant fragility for the TCC-gated tools is tracked in issue #44 (stable-signed
  binary / app bundle). Until it lands, grants attach to opencode's
  launchd-parented ad-hoc-signed binary and must be re-applied per install.

## 0.19.x and earlier

See git history. Highlights: legacy-memory CLI binary rename (`madcat`),
newspaper/Kindle numbered-issue delivery, module-relative script packaging fix,
and CI publish pipeline (push to `master` auto-publishes to the Gitea npm
registry).
