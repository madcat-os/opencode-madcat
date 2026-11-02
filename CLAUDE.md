# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the canonical project handbook (structure, install/verify steps,
known pitfalls). Read it first; this file covers what it does not.

## Commands

There is no build step and no test suite. The package ships TypeScript source that opencode's Bun
runtime executes directly, so the two checks below are the whole gate.

```bash
npx tsc --noEmit                                   # type-check — zero errors required before any push
bun -e 'const m = await import("./src/index.ts"); console.log("OK:", typeof m.default)'   # load test
```

A type error (even a missing comma) kills the whole plugin at load with no log output from the
serve, which is why `tsc` is mandatory.

## Release flow

- Commit messages for releases are `X.Y.Z: description`; bump `package.json` in the same commit.
- CI (`.github/workflows/publish.yml`) only runs `npm publish` to npmjs. There is no build step.
  Pushes to `master` publish as dist-tag `latest`; pushes to `v2.0` (and any other branch listed in
  the workflow) publish as `next`, so `@latest` consumers are not upgraded. A version that already
  exists on the registry is skipped, so doc-only pushes do not fail.
- No native binaries ship. `src/assets/Hack-Regular.ttf` and the `@resvg/resvg-wasm` wasm blob are
  the only non-TypeScript artifacts; the wasm is resolved through the package's export map.
- `.opencode/opencode.json` points `plugin` at a local checkout path for in-repo development on the
  linux dev host. It is not consumed by published installs.

## Architecture: how a tool reaches opencode

The plugin is V2 (`@opencode/plugin`) but every tool module is written in the V1 shape, and
`src/index.ts` does the adaptation. Understanding this pipeline is most of what you need.

1. **Author** a tool in `src/tools/<namespace>.ts` with the local `tool()` shim from
   `src/lib/tool.ts`: `{ description, args: ZodRawShape, execute(args, ctx) }`. `tool.schema` is
   Zod. `execute` returns a string or `{ output, metadata?, attachments? }`.
2. **Export** it as a named export. `index.ts` calls `ns("json", json)`, which turns every export
   that looks like a tool definition into `json_<exportName>`. The tool's public name is derived
   from the namespace prefix in `index.ts` plus the export name, so renaming an export renames the
   tool. Non-tool exports (helpers, types) are ignored by `ns()`.
3. **Register** a new namespace by importing the module in `index.ts` and adding one `...ns(...)`
   line to `defs`. There is no other registry.
4. At setup, `index.ts` wraps each definition in `editor.add()`, converting `args` to
   `z.object(args)` as the V2 input schema, rebuilding a V1-style `ToolContext` (adds `directory`,
   `worktree`, `abort` from `ctx.location` / `context.signal`), and normalizing the result to V2
   `{ content }`.

Two near-identical `ToolContext` types exist (`src/lib/tool.ts` and `src/lib/identity.ts`). They
are structurally compatible; tools that talk to the mesh import the `identity.ts` one.

**EEMS modules** (`tools/memory.ts`, `tools/indexer.ts`) are pure TypeScript and statically
imported. `lib/native.ts` resolves the store lazily and never throws at module init; a missing
sign-in surfaces from the first tool call and from `whoami_info`, not from plugin load.

**Result convention:** tools return JSON strings, never thrown errors. `run()` in `src/lib/sdk.ts`
wraps a client call and returns `{ error }` JSON on failure. Follow this so a tool failure never
surfaces as a plugin crash.

## Hooks and events

- `ctx.session.hook("context", ...)` runs `hooks/persona.ts` then `hooks/doctrine.ts`, both of
  which push `{ type: "text", text }` blocks onto `event.system`. Persona resolves the cart fresh
  on every call (no cache) and skips agents in `SKIP_AGENTS`.
- `ctx.event.subscribe()` dispatches `session.idle` to `hooks/idle.ts`. V2 events carry
  `event.data`, not `event.properties`. Context compaction is left to opencode's built-in
  auto-compaction (`compaction.*` in `opencode.jsonc`); the plugin does not trigger it.
- Hooks swallow their own errors by design. A failing hook must degrade, not throw.

## Doctrines

`src/doctrines/*.md` start with an `applies_to:` line, then a `---` separator, then the body.
`applies_to` is a comma list of exact agent names, prefix globs like `build*`, or `*`. Files
without a valid header or body are silently skipped. `lib/mirror.ts` copies all doctrines into
EEMS as `doctrine.<slug>` at plugin init; the filesystem remains canonical.

## Configuration and connectivity

- `src/lib/config.ts` parses `~/.config/madcat/config.toml` once and exposes typed getters with
  precedence env var → TOML → hardcoded default. Add a getter there rather than reading
  `process.env` in a tool.
- `sdk(host)` in `src/lib/sdk.ts` builds an authenticated `@opencode/client` for a `[mesh.<host>]`
  entry. V2 client calls return the body directly and throw on error. A trailing `/api` on the
  configured URL is stripped because the client adds it.
- `lib/identity.ts` `buildCallerHeader()` prepends a `<caller>`/`<dispatch>` block to prompts sent
  to other sessions so the remote agent knows how to report back via `messages_prompt_async`.
- EEMS memory has two modes. With `EEMS_DSN_CORE` and `EEMS_DSN_DOUBLE` set, `lib/native.ts`
  routes each call to a per-agent store by `context.agent` (`double` vs everything else).
  Otherwise `lib/principal.ts` reads the Madcat menubar session file, calls `{web}/api/me` for
  the user's `db_name`, and the store/index/mirror open `{db_name}_{db}` on the `[database].dsn`
  server (or `[database].user_dsn` with `{db_name}` filled in). No sign-in, expired token, 401,
  or a missing instanced database → memory and index tools throw; there is no fallback to the
  shared base DB. `lib/db.ts` is a separate pure-JS Postgres connection used for PRIME locks and
  core-schema config.
- `lib/eems.ts` keeps one `postgres` pool per DSN shared by `MemoryStore` and `CodeIndex`, and
  runs `src/lib/sql/eems_init.sql` (idempotent) once per pool. pgvector values are bound as
  `'[f,f,...]'::vector` text; jsonb via `sql.json()` (a plain string binds as a JSON string).
