/**
 * JSON tools — read, query, edit, merge, validate JSON files.
 * Supports local and remote (SSH) paths via host:path syntax.
 *
 * Remote pattern: "sin:/home/madcat/.config/opencode/opencode.json"
 * Local pattern:  "/Users/chi/Projects/madcat-hq/package.json"
 */

import { tool } from "../lib/tool"
import { readFileSync, writeFileSync } from "fs"

// ── Helpers ──────────────────────────────────────────────────────────

/** SSH user for remote hosts */
const SSH_USER = "madcat"

/** Parse "host:/path" or plain "/path" */
function parsePath(raw: string): { remote: string | null; path: string } {
  const m = raw.match(/^([a-zA-Z][\w-]*):(\/.+)$/)
  if (m) return { remote: m[1], path: m[2] }
  return { remote: null, path: raw }
}

/** Read file content — local or over SSH */
async function readFile(raw: string): Promise<string> {
  const { remote, path } = parsePath(raw)
  if (remote) {
    const proc = Bun.spawn(["ssh", `${SSH_USER}@${remote}`, "cat", path], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const code = await proc.exited
    if (code !== 0) throw new Error(`ssh cat failed (${code}): ${stderr.trim()}`)
    return stdout
  }
  return readFileSync(path, "utf-8")
}

/** Write file content — local or over SSH */
async function writeFile(raw: string, content: string): Promise<void> {
  const { remote, path } = parsePath(raw)
  if (remote) {
    const proc = Bun.spawn(
      ["ssh", `${SSH_USER}@${remote}`, "bash", "-c", `cat > '${path}'`],
      { stdin: "pipe", stderr: "pipe" }
    )
    proc.stdin!.write(content)
    proc.stdin!.end()
    const stderr = await new Response(proc.stderr).text()
    const code = await proc.exited
    if (code !== 0) throw new Error(`ssh write failed (${code}): ${stderr.trim()}`)
    return
  }
  writeFileSync(path, content, "utf-8")
}

/** Resolve a dot-path like "server.port" or "items[2].name" into segments */
function pathSegments(dotPath: string): (string | number)[] {
  const segs: (string | number)[] = []
  for (const part of dotPath.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (part === "") continue
    const n = Number(part)
    segs.push(Number.isInteger(n) && String(n) === part ? n : part)
  }
  return segs
}

/** Get value at a dot-path */
function getAtPath(obj: any, dotPath: string): any {
  let cur = obj
  for (const seg of pathSegments(dotPath)) {
    if (cur == null || typeof cur !== "object") return undefined
    cur = cur[seg]
  }
  return cur
}

/** Set value at a dot-path (mutates in place) */
function setAtPath(obj: any, dotPath: string, value: any): void {
  const segs = pathSegments(dotPath)
  let cur = obj
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]
    const next = segs[i + 1]
    if (cur[seg] == null || typeof cur[seg] !== "object") {
      cur[seg] = typeof next === "number" ? [] : {}
    }
    cur = cur[seg]
  }
  cur[segs[segs.length - 1]] = value
}

/** Delete value at a dot-path (mutates in place). Returns true if deleted. */
function deleteAtPath(obj: any, dotPath: string): boolean {
  const segs = pathSegments(dotPath)
  let cur = obj
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return false
    cur = cur[segs[i]]
  }
  const last = segs[segs.length - 1]
  if (cur == null || typeof cur !== "object") return false
  if (Array.isArray(cur) && typeof last === "number") {
    if (last >= 0 && last < cur.length) {
      cur.splice(last, 1)
      return true
    }
    return false
  }
  if (last in cur) {
    delete cur[last]
    return true
  }
  return false
}

/** Deep merge src into target (mutates target) */
function deepMerge(target: any, src: any): any {
  if (
    typeof target !== "object" || target === null ||
    typeof src !== "object" || src === null ||
    Array.isArray(target) || Array.isArray(src)
  ) {
    return src
  }
  for (const key of Object.keys(src)) {
    if (
      key in target &&
      typeof target[key] === "object" && target[key] !== null && !Array.isArray(target[key]) &&
      typeof src[key] === "object" && src[key] !== null && !Array.isArray(src[key])
    ) {
      deepMerge(target[key], src[key])
    } else {
      target[key] = src[key]
    }
  }
  return target
}

/** Describe a value's type for keys listing */
function describeType(v: any): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return `array[${v.length}]`
  if (typeof v === "object") return `object{${Object.keys(v).length}}`
  return typeof v
}

// ── Tools ────────────────────────────────────────────────────────────

export const read = tool({
  description:
    "Read and parse a JSON file. Local path or remote via host:path (e.g. sin:/home/madcat/file.json). " +
    "Optional dot-path query to extract a subset (e.g. 'server.port', 'models[0].name').",
  args: {
    file: tool.schema.string().describe("File path — local or host:/path for remote SSH"),
    path: tool.schema.string().optional().describe("Dot-path to query (e.g. 'server.port', 'items[2]')"),
  },
  async execute(args) {
    try {
      const raw = await readFile(args.file)
      const parsed = JSON.parse(raw)
      const result = args.path ? getAtPath(parsed, args.path) : parsed
      if (result === undefined) return `Path "${args.path}" not found in ${args.file}`
      return JSON.stringify(result, null, 2)
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
})

export const set = tool({
  description:
    "Set a value at a dot-path in a JSON file. Creates intermediate objects/arrays as needed. " +
    "Local or remote via host:path.",
  args: {
    file: tool.schema.string().describe("File path — local or host:/path"),
    path: tool.schema.string().describe("Dot-path to set (e.g. 'server.port', 'features[0]')"),
    value: tool.schema.string().describe("Value to set (JSON-encoded — use '\"hello\"' for strings, '42' for numbers, 'true' for bools, '{...}' for objects)"),
  },
  async execute(args) {
    try {
      const raw = await readFile(args.file)
      const parsed = JSON.parse(raw)
      let val: any
      try { val = JSON.parse(args.value) } catch { val = args.value }
      setAtPath(parsed, args.path, val)
      const out = JSON.stringify(parsed, null, 2) + "\n"
      await writeFile(args.file, out)
      return `Set ${args.path} = ${JSON.stringify(val)} in ${args.file}`
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
})

export const del = tool({
  description:
    "Delete a key or array element at a dot-path in a JSON file. Local or remote via host:path.",
  args: {
    file: tool.schema.string().describe("File path — local or host:/path"),
    path: tool.schema.string().describe("Dot-path to delete (e.g. 'server.cors', 'models[2]')"),
  },
  async execute(args) {
    try {
      const raw = await readFile(args.file)
      const parsed = JSON.parse(raw)
      const ok = deleteAtPath(parsed, args.path)
      if (!ok) return `Path "${args.path}" not found in ${args.file}`
      const out = JSON.stringify(parsed, null, 2) + "\n"
      await writeFile(args.file, out)
      return `Deleted ${args.path} from ${args.file}`
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
})

export const merge = tool({
  description:
    "Deep merge a JSON object into an existing JSON file. Objects merge recursively; " +
    "arrays and primitives are overwritten. Local or remote via host:path.",
  args: {
    file: tool.schema.string().describe("File path — local or host:/path"),
    data: tool.schema.string().describe("JSON object to merge (e.g. '{\"server\":{\"port\":5000}}')"),
  },
  async execute(args) {
    try {
      const raw = await readFile(args.file)
      const parsed = JSON.parse(raw)
      const patch = JSON.parse(args.data)
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        return "Error: merge data must be a JSON object"
      }
      deepMerge(parsed, patch)
      const out = JSON.stringify(parsed, null, 2) + "\n"
      await writeFile(args.file, out)
      const keys = Object.keys(patch)
      return `Merged ${keys.length} key(s) into ${args.file}: ${keys.join(", ")}`
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
})

export const keys = tool({
  description:
    "List keys of a JSON file (or at a dot-path) with their types and sizes. " +
    "Quick structural overview without dumping the whole file.",
  args: {
    file: tool.schema.string().describe("File path — local or host:/path"),
    path: tool.schema.string().optional().describe("Dot-path to inspect (omit for root)"),
  },
  async execute(args) {
    try {
      const raw = await readFile(args.file)
      const parsed = JSON.parse(raw)
      const target = args.path ? getAtPath(parsed, args.path) : parsed
      if (target === undefined) return `Path "${args.path}" not found in ${args.file}`
      if (typeof target !== "object" || target === null) {
        return `Value at ${args.path || "root"}: ${describeType(target)} = ${JSON.stringify(target)}`
      }
      if (Array.isArray(target)) {
        const items = target.slice(0, 20).map((v, i) => `  [${i}]: ${describeType(v)}`)
        const suffix = target.length > 20 ? `\n  ... (${target.length - 20} more)` : ""
        return `Array[${target.length}] at ${args.path || "root"}:\n${items.join("\n")}${suffix}`
      }
      const entries = Object.entries(target).map(([k, v]) => `  ${k}: ${describeType(v)}`)
      return `Object{${entries.length}} at ${args.path || "root"}:\n${entries.join("\n")}`
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
})

export const validate = tool({
  description:
    "Validate a JSON file — check syntax and report errors. Local or remote via host:path.",
  args: {
    file: tool.schema.string().describe("File path — local or host:/path"),
  },
  async execute(args) {
    try {
      const raw = await readFile(args.file)
      try {
        const parsed = JSON.parse(raw)
        const type = Array.isArray(parsed) ? "array" : typeof parsed
        const size = raw.length
        const keyCount = typeof parsed === "object" && parsed !== null
          ? Object.keys(parsed).length
          : null
        let summary = `Valid JSON (${type}, ${size} bytes)`
        if (keyCount !== null) summary += `, ${keyCount} top-level keys`
        return summary
      } catch (parseErr: any) {
        const msg = parseErr.message || "Unknown parse error"
        // Try to find the line/col from the error message
        const posMatch = msg.match(/position (\d+)/)
        if (posMatch) {
          const pos = Number(posMatch[1])
          const before = raw.slice(0, pos)
          const line = (before.match(/\n/g) || []).length + 1
          const col = pos - before.lastIndexOf("\n")
          return `Invalid JSON at line ${line}, col ${col}: ${msg}`
        }
        return `Invalid JSON: ${msg}`
      }
    } catch (e: any) {
      return `Error reading file: ${e.message}`
    }
  },
})
