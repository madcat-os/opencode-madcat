/**
 * repos.toml reader — discovers which madcat repos are available on this host.
 *
 * Reads ~/.config/madcat/repos.toml, resolves ~ in paths, checks which
 * paths actually exist on the current host. Creates a default repos.toml
 * if missing (soft fail — never blocks plugin load).
 *
 * Host-agnostic: paths use ~ which resolves per-host. A repo that exists
 * on fuji but not on sin is simply absent from sin's resolved list.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { parse } from "smol-toml"

const REPOS_PATH = join(homedir(), ".config", "madcat", "repos.toml")

export interface RepoEntry {
  name: string
  path: string
  resolvedPath: string
  description: string
  lang: string
  role: string
  exists: boolean
}

export interface ConfigPaths {
  madcat: string
  carts: string
  opencode: string
  eems_db: string
}

export interface ReposManifest {
  repos: RepoEntry[]
  config: ConfigPaths
}

function resolve(p: string): string {
  return p.replace(/^~/, homedir())
}

const DEFAULT_REPOS_TOML = `# MADCAT OS — repository registry
# Host-agnostic: paths use ~ which resolves per-host.
# The plugin scans each path at startup — missing repos are skipped.

[repos.madcat]
path = "~/Projects/madcat"
description = "Core monorepo — Rust binary, NAPI bindings, madcat-qualifier"
lang = "rust"
role = "substrate"

[repos.madcat-plugin]
path = "~/Projects/madcat-plugin"
description = "Opencode plugin — all MCP tools, hooks, doctrine injection, EEMS bridge"
lang = "typescript"
role = "plugin"

[repos.madcat-tts]
path = "~/Projects/madcat-tts"
description = "TTS daemon — Chatterbox, Piper engines, cart/voice registry, text normalization"
lang = "python"
role = "service"

[repos.madcat-memory]
path = "~/Projects/madcat-memory"
description = "EEMS memory crate — FFI-first store with NAPI/PyO3/Magnus bindings, indexer"
lang = "rust"
role = "library"

[repos.madcat-tools]
path = "~/Projects/madcat-tools"
description = "NAPI browser binding — headless Playwright automation tools"
lang = "rust"
role = "library"

[repos.madcat-ml]
path = "~/Projects/madcat-ml"
description = "ML training Docker image — RunPod/H100/H200 LoRA training infra"
lang = "docker"
role = "infra"

[repos.lora]
path = "~/Projects/lora"
description = "LoRA training data and scripts — dataset generation, training, evaluation"
lang = "python"
role = "training"

[config]
madcat = "~/.config/madcat/config.toml"
carts = "~/.config/madcat/carts/"
opencode = "~/.config/opencode/opencode.jsonc"
eems_db = "~/.local/share/madcat/eems-v2.db"
`

let _manifest: ReposManifest | null = null

export function loadRepos(): ReposManifest {
  if (_manifest) return _manifest

  // Create default if missing
  if (!existsSync(REPOS_PATH)) {
    try {
      mkdirSync(dirname(REPOS_PATH), { recursive: true })
      writeFileSync(REPOS_PATH, DEFAULT_REPOS_TOML, "utf-8")
    } catch {
      // soft fail
    }
  }

  let raw: Record<string, any> = {}
  try {
    raw = parse(readFileSync(REPOS_PATH, "utf-8"))
  } catch {
    raw = {}
  }

  const repos: RepoEntry[] = []
  const reposSection = (raw.repos ?? {}) as Record<string, any>
  for (const [name, entry] of Object.entries(reposSection)) {
    if (!entry || typeof entry !== "object" || !entry.path) continue
    const resolvedPath = resolve(entry.path)
    repos.push({
      name,
      path: entry.path,
      resolvedPath,
      description: entry.description ?? "",
      lang: entry.lang ?? "",
      role: entry.role ?? "",
      exists: existsSync(resolvedPath),
    })
  }

  const cfgSection = (raw.config ?? {}) as Record<string, string>
  const config: ConfigPaths = {
    madcat: resolve(cfgSection.madcat ?? "~/.config/madcat/config.toml"),
    carts: resolve(cfgSection.carts ?? "~/.config/madcat/carts/"),
    opencode: resolve(cfgSection.opencode ?? "~/.config/opencode/opencode.jsonc"),
    eems_db: resolve(cfgSection.eems_db ?? "~/.local/share/madcat/eems-v2.db"),
  }

  _manifest = { repos, config }
  return _manifest
}

/**
 * Build a system prompt block describing available infrastructure.
 * Only includes repos that exist on this host.
 */
export function infraPrompt(): string {
  const { repos, config } = loadRepos()
  const present = repos.filter((r) => r.exists)
  const absent = repos.filter((r) => !r.exists)

  const lines: string[] = [
    "## MADCAT OS Infrastructure (this host)",
    "",
    "You are running on the MADCAT OS substrate. The following repos are available on this host:",
    "",
  ]

  for (const r of present) {
    lines.push(`- **${r.name}** (${r.lang}) — ${r.description}`)
    lines.push(`  Path: \`${r.resolvedPath}\``)
  }

  if (absent.length > 0) {
    lines.push("")
    lines.push(`Not on this host: ${absent.map((r) => r.name).join(", ")}`)
  }

  lines.push("")
  lines.push("### Config locations")
  lines.push(`- Config: \`${config.madcat}\``)
  lines.push(`- Carts: \`${config.carts}\``)
  lines.push(`- EEMS DB: \`${config.eems_db}\``)
  lines.push(`- Opencode: \`${config.opencode}\``)
  lines.push("")
  lines.push(
    "### Repair protocol",
    "If a component is broken (tools failing, TTS down, memory errors, config mismatch):",
    "1. Read the relevant config file and repo source to diagnose",
    "2. Propose a fix with exact file + line + change",
    "3. **Do NOT apply fixes without explicit operator approval** — always ask first",
  )

  return lines.join("\n")
}
