import { existsSync, readFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { parse } from "smol-toml"

export const CONFIG_PATH = join(homedir(), ".config", "madcat", "config.toml")

export interface HostConfig {
  name: string
  url: string
  password: string
  username: string
  directory?: string
}

export interface MeshConfig {
  self: string
  hosts: HostConfig[]
}

export class ConfigError extends Error {
  override name = "MeshConfigError"
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function host(name: string, raw: unknown): HostConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`[mesh.${name}] must be a table`)
  }
  const table = raw as Record<string, unknown>
  const url = text(table.url)
  if (!url) throw new ConfigError(`[mesh.${name}] needs a url`)
  const password = text(table.password)
  if (!password) throw new ConfigError(`[mesh.${name}] needs a password`)
  return {
    name,
    url: url.replace(/\/+$/, "").replace(/\/api$/, ""),
    password,
    username: text(table.username) ?? "opencode",
    directory: text(table.directory),
  }
}

export function parseMesh(toml: string): MeshConfig {
  const root = parse(toml) as Record<string, unknown>
  const mesh = root.mesh
  if (mesh === undefined) throw new ConfigError("no [mesh] section")
  if (mesh === null || typeof mesh !== "object" || Array.isArray(mesh)) {
    throw new ConfigError("[mesh] must be a table")
  }
  const table = mesh as Record<string, unknown>
  const hosts: HostConfig[] = []
  for (const [key, value] of Object.entries(table)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      hosts.push(host(key, value))
    }
  }
  if (hosts.length === 0) throw new ConfigError("no [mesh.<host>] tables")

  const self = text(table.self) ?? process.env.MADCAT_MESH_SELF ?? hostname().split(".")[0] ?? ""
  if (!hosts.some((h) => h.name === self)) {
    throw new ConfigError(
      `mesh.self is "${self}" but there is no [mesh.${self}] table (hosts: ${hosts.map((h) => h.name).join(", ")})`,
    )
  }
  return { self, hosts }
}

export function loadMesh(path = CONFIG_PATH): MeshConfig {
  if (!existsSync(path)) throw new ConfigError(`${path} not found`)
  return parseMesh(readFileSync(path, "utf-8"))
}
