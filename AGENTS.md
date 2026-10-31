# AGENTS.md — @madcat-os/opencode-madcat

## What this is

OpenCode plugin for the MADCAT operating system. Runs inside opencode's Bun runtime — TypeScript executed natively, no compilation step. Registers ~120 custom tools (memory, TTS, messaging, mesh orchestration, infra, etc.), persona hooks, doctrine mirroring, and event handlers.

Published to npmjs as `@madcat-os/opencode-madcat` from GitHub Actions. Consumed by opencode instances on fuji, sin, and junkpile via the `"plugin"` array in `opencode.jsonc`.

## Repository

- **Registry**: npmjs (`https://registry.npmjs.org`)
- **Git**: `git@github.com:madcat-os/opencode-madcat.git`
- **CI**: GitHub Actions — push to `master` publishes (`.github/workflows/publish.yml`; secret `NPM_TOKEN`)

## Structure

```
src/
  index.ts          # Plugin entry — exports default Plugin, registers all tools + hooks
  lib/              # Shared libraries
    native.ts       # EEMS store/index resolution: dual-DSN → signed-in principal
    eems.ts         # MemoryStore + CodeIndex — Postgres + pgvector, pure TS
    embed.ts        # Embedding client (ollama /api/embed or openai /v1/embeddings)
    chunk.ts        # Language-aware chunking (port of madcat-memory chunk.rs)
    walk.ts         # Gitignore-aware file walker (git ls-files, SKIP_DIRS, ext filters)
    principal.ts    # Menubar session → /api/me → user's instanced DSN
    sql/eems_init.sql # Idempotent EEMS schema (memories, edges, chunks_*, file_state)
    audio.ts        # Local playback: spawns afplay / pw-play / paplay / aplay, tracks procs
    silicon.ts      # Code → PNG: shiki tokens → SVG window frame → resvg-wasm
    config.ts       # Reads ~/.config/madcat/config.toml — mesh hosts, TTS, embedding, DB, web URL
    db.ts           # Postgres connection (porsager/postgres) — PRIME locks, dual-DSN core access
    sdk.ts          # @opencode/client factory — talks to local/remote V2 opencode serves
    user-resolver.ts # Dual-DSN env var resolution (EEMS_DSN_CORE / EEMS_DSN_DOUBLE)
    identity.ts     # ToolContext type, agent identity resolution
    mirror.ts       # Filesystem → EEMS doctrine mirroring
    doctrines.ts    # Loads doctrine markdown files from src/doctrines/
    repos.ts        # Infrastructure prompt generation
    firefox.ts      # Firefox cookie import for job search
  tools/            # One file per tool namespace — exports tool definitions via tool() helper
    memory.ts       # EEMS memory (recall, store, list, get, forget, classify, link, graph)
    sessions.ts     # Session list, status, get, diff, children, search, ingest
    whoami.ts       # Identity bootstrap — session, host, persona, operator, guidance
    cart.ts         # Persona cart management (info, list, load)
    tts.ts          # Text-to-speech (speak, switch_voice, list, active, health)
    signal.ts       # Signal messaging (send, voice)
    whatsapp.ts     # WhatsApp messaging (send, voice)
    prime.ts        # PRIME session lock (claim, release, status)
    messages.ts     # Cross-session messaging (prompt, prompt_async, read)
    control.ts      # Session lifecycle (create, remove, abort, fork, revert, etc.)
    ...             # 30+ more tool files
  assets/
    Hack-Regular.ttf # Monospace font embedded in code screenshots
  hooks/
    persona.ts      # System prompt injection — resolves cart from file/DB, injects identity
    doctrine.ts     # Injects operational doctrine into system prompt
    idle.ts         # Session idle event handler
  doctrines/        # Markdown doctrine files mirrored to EEMS at plugin init
skills/
  kindle/           # Kindle delivery skill
  newspaper/        # Kindle newspaper build script
```

## EEMS (memory + index)

Pure TypeScript on the `postgres` package — no binaries. `src/lib/eems.ts` holds `MemoryStore`
(store/recall/get/forget/classify/listSubjects/link/graph) and `CodeIndex`
(indexCode/indexDocs/search/clear/status); both are async. Hybrid recall is pgvector cosine +
tsvector `ts_rank`, RRF-fused in SQL. Embeddings come from the `[embedding]` endpoint.

Which database a call hits (`src/lib/native.ts`):

1. **Dual-DSN** (`EEMS_DSN_CORE` + `EEMS_DSN_DOUBLE` set): per-agent DSN by `context.agent`.
2. **Signed-in principal** (`src/lib/principal.ts`): the Madcat menubar's desktop session file
   (`~/Library/Application Support/Madcat/session-<host>.json`, Linux `$XDG_DATA_HOME/Madcat/`)
   → `GET {web}/api/me` → `db_name` → `{db_name}_{db}` on the `[database].dsn` server
   (`-` → `_`), or `[database].user_dsn` with `{db_name}` filled in. The database must already
   exist; the madcat server creates it.

No fallback: missing/expired session, 401, unreachable madcat-web, or a missing instanced DB
makes `memory_*` / `index_*` / the doctrine mirror fail with a sign-in instruction. Plugin load
is unaffected; `whoami_info.eems` reports the state.

## Audio playback

`src/lib/audio.ts` spawns the platform player per clip — `afplay` on macOS, the first of
`pw-play` / `paplay` / `aplay` on Linux — and tracks every process, so `stopAll()` / `isPlaying()`
work and `tts_speak` observes real completion (`proc.exited`) before clearing the ear mute flag.
No player on PATH → `tts_speak` reports `backend: "none"` and playback throws.

## Code screenshots

`src/lib/silicon.ts` highlights with shiki (TextMate grammars, 65 bundled VS Code themes), lays
the window frame out as SVG with the same geometry the Rust renderer used, and rasterises through
`@resvg/resvg-wasm` with `src/assets/Hack-Regular.ttf`. Pure JS + wasm, works on every platform.
Old syntect theme names (`base16-ocean.dark`, `InspiredGitHub`, …) map to the nearest shiki theme.

No NAPI binaries ship anymore; there is nothing platform-specific in `src/tools/`.

## Key dependencies

| Package | Role |
|---|---|
| `@opencode/plugin` | V2 plugin SDK — `Plugin.define`, `ctx.tool`/`session`/`event` |
| `@opencode/client` | V2 opencode HTTP client — `OpenCode.make()` for mesh hosts |
| `postgres` | Pure JS Postgres client — PRIME locks, dual-DSN core schema |
| `smol-toml` | TOML parser — reads config.toml and cart files |
| `shiki` | Syntax highlighting for `code_screenshot` |
| `@resvg/resvg-wasm` | SVG → PNG rasteriser for `code_screenshot` |
| `@firecrawl/pdf-inspector` | PDF text extraction for ingest tools |
| `@kreuzberg/html-to-markdown-node` | HTML → markdown for ingest tools |

## Development workflow

### Pre-publish checklist

```bash
# 1. Type-check — MANDATORY, zero errors required
npx tsc --noEmit

# 2. Test load in Bun
bun -e 'const m = await import("./src/index.ts"); console.log("OK:", typeof m.default)'

# 3. Bump version in package.json

# 4. Commit
git add -A && git commit -m "X.Y.Z: description"

# 5. Push (GitHub Actions publishes) or publish manually
git push origin master
# or: npm publish --registry https://registry.npmjs.org --access public
```

### Install on a host

```bash
# Proper way — handles cache, config update, Bun install
opencode plugin '@madcat-os/opencode-madcat@X.Y.Z' --global --force

# Then restart the serve
systemctl --user restart homebrew.opencode-serve.service
```

### Verify plugin loaded

Create a fresh session and confirm `whoami_info` is a real tool call (not a bash fallback). Check serve logs:
```
~/.local/share/opencode/log/opencode.log
```

If plugin fails silently, test directly:
```bash
cd ~/.cache/opencode/packages/@madcat-os/opencode-madcat@X.Y.Z/node_modules/@madcat-os/opencode-madcat
bun -e 'const m = await import("./src/index.ts"); console.log(typeof m.default)'
```

## Known pitfalls

1. **Never `npm install` in `~/.config/opencode/`** — creates `node_modules/` that shadows the cache. Use `opencode plugin` CLI only.
2. **Never leave `.opencode/` in the serve's working directory** (e.g. `/home/madcat/.opencode/`) — project-level config merges in and can inject bogus plugins.
3. **Always type-check before publishing** — syntax errors (even a missing comma) silently kill the entire plugin with zero log output from the serve.
4. **Memory tools need a menubar sign-in** — on a host without a `session-<host>.json` (and no dual-DSN env), every `memory_*` / `index_*` call throws. Check `whoami_info.eems.reason`.
5. **Plugin tools are NOT bash commands** — agents should call them as MCP tools. If an agent runs `whoami_info` in bash, the plugin isn't loaded.

## Configuration

The plugin reads `~/.config/madcat/config.toml` for:
- `[mesh.*]` — opencode serve URLs and credentials for cross-host operations
- `[tts]` — TTS daemon URL, default voice
- `[embedding]` — `provider` (ollama|openai), `url`, `model`, `dimensions`, `api_key`
- `[database]` — `dsn` (base Postgres DSN), optional `user_dsn` template with `{db_name}`
- `[web].url` / `[mcp].oauth_issuer` — madcat-web origin for `/api/me` (default `https://madcat-os.com`)
- `[signal]` / `[whatsapp]` — messaging bridge config
- `[mcp].disabled_tools` — tools to exclude from registration

The Kindle/newspaper skills read identity from the environment (`opencode-serve.env`):
`MADCAT_MAIL_SENDER`, `MADCAT_MAIL_ACCOUNT` (optional), `MADCAT_KINDLE_EMAIL`, `MADCAT_MAIL_DISPLAY`.
Nothing host- or operator-specific is checked in; the package is public on npmjs.

Dual-DSN mode (per-user memory isolation) is activated by env vars:
- `EEMS_DSN_CORE` — Postgres DSN for the user's core schema
- `EEMS_DSN_DOUBLE` — Postgres DSN for the user's double schema
