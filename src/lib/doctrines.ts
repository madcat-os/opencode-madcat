/**
 * Doctrine registry — loads markdown files from src/doctrines/ at module init
 * and exposes a filter by agent name.
 *
 * File format:
 *   applies_to: core, build*, worker, *
 *   ---
 *   <markdown body>
 *
 * `applies_to` is a comma-separated allowlist. Each entry is either:
 *   - an exact agent name ("worker")
 *   - a wildcard "*" (matches any agent)
 *   - a prefix glob ending in "*" ("build*" matches "build", "build-rust", ...)
 */

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DOCTRINES_DIR = join(__dirname, "..", "doctrines")

export type Doctrine = {
  slug: string
  applies_to: string[]
  content: string
}

let cache: Doctrine[] | null = null

function parseDoctrine(slug: string, raw: string): Doctrine | null {
  const split = raw.indexOf("\n---\n")
  if (split === -1) return null
  const header = raw.slice(0, split)
  const body = raw.slice(split + 5).trim()

  const appliesMatch = header.match(/^applies_to:\s*(.+)$/m)
  const applies_to = appliesMatch
    ? appliesMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : []

  if (applies_to.length === 0 || !body) return null
  return { slug, applies_to, content: body }
}

function loadAll(): Doctrine[] {
  if (cache !== null) return cache
  const out: Doctrine[] = []
  try {
    for (const file of readdirSync(DOCTRINES_DIR)) {
      if (!file.endsWith(".md")) continue
      const slug = file.replace(/\.md$/, "")
      const raw = readFileSync(join(DOCTRINES_DIR, file), "utf-8")
      const d = parseDoctrine(slug, raw)
      if (d) out.push(d)
    }
  } catch {
    // doctrines dir missing or unreadable — empty list
  }
  cache = out
  return cache
}

function matchAgent(pattern: string, agent: string): boolean {
  if (pattern === "*" || pattern === agent) return true
  if (pattern.endsWith("*")) {
    return agent.startsWith(pattern.slice(0, -1))
  }
  return false
}

export function doctrinesFor(agent: string): Doctrine[] {
  if (!agent) return []
  return loadAll().filter((d) =>
    d.applies_to.some((p) => matchAgent(p, agent)),
  )
}

/** All loaded doctrines, regardless of agent. Used by the EEMS mirror. */
export function allDoctrines(): Doctrine[] {
  return loadAll()
}
