# OpenCode plugin docs

Local markdown snapshots of the OpenCode V2 plugin documentation, fetched from
<https://opencode.ai/v2/docs/> on 2026-11-04. The site serves markdown directly
with `Accept: text/markdown`.

| File | Source | What it covers |
|---|---|---|
| [plugins-overview.md](plugins-overview.md) | `/build/plugins/` | Plugin package shape, entrypoints, server/TUI/GUI parts |
| [plugins-server.md](plugins-server.md) | `/build/plugins/server/` | Server plugins: lifecycle, transforms, context API (sessions, tools, events), hooks |
| [plugins-rpc.md](plugins-rpc.md) | `/build/plugins/rpc/` | Custom RPC methods and events shared across plugins and clients |
| [plugins-tui.md](plugins-tui.md) | `/build/plugins/cli/` | TUI plugin part |
| [plugins-gui.md](plugins-gui.md) | `/build/plugins/gui/` | Desktop GUI plugin SDK |
| [plugins-effect.md](plugins-effect.md) | `/build/plugins/effect/` | Effect-native plugin API |
| [plugins-effect-rpc.md](plugins-effect-rpc.md) | `/build/plugins/effect/rpc/` | Effect-native RPC |
| [plugins-migrate-v1.md](plugins-migrate-v1.md) | `/build/plugins/migrate-v1/` | V1 → V2 plugin API migration |
| [plugins-config.md](plugins-config.md) | `/plugins/` | Loading and configuring plugins in `opencode.json(c)` |
| [plugins-cli-settings.md](plugins-cli-settings.md) | `/cli/plugins/` | Terminal plugin settings in `cli.json` |
| [client-javascript.md](client-javascript.md) | `/build/client/` | `@opencode/client` — remote session API, event streaming, RPC over HTTP |
| [cli-web.md](cli-web.md) | `/cli/web/` | Exposing a server on the network, Basic auth, `OPENCODE_PASSWORD`, `serve` |
| [network.md](network.md) | `/network/` | Proxy and certificate env for the service |
| [openapi.json](openapi.json) | `/openapi.json` | Full HTTP API spec (the `/api/` docs page is HTML-only) |

Project docs (ours, not snapshots):

- [PLAN.md](PLAN.md) — mesh steering architecture and decisions
- [PRIOR-ART.md](PRIOR-ART.md) — survey of existing session-orchestration plugins

Refresh with:

```sh
curl -sfL -H 'Accept: text/markdown' https://opencode.ai/v2/docs/build/plugins/server/ -o docs/plugins-server.md
```
