/**
 * Document ingest tools — convert HTML, PDF, and structured JSON to markdown,
 * then feed through the existing doc indexer.
 *
 * HTML: @kreuzberg/html-to-markdown (Rust NAPI, strips nav/boilerplate)
 * PDF:  @firecrawl/pdf-inspector (Rust NAPI, text extraction + markdown)
 * JSON: built-in serialization to readable text
 *
 * All three write .md files to a temp dir, then call indexDocs() on it.
 */

import { tool } from "../lib/tool"
import { codeIndex } from "../lib/native.ts"
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "fs"
import { join, basename, extname, relative } from "path"
import { tmpdir } from "os"

const db = codeIndex

// ── Helpers ──

/** Recursively find files matching given extensions under root. */
function findFiles(root: string, exts: string[]): string[] {
  const results: string[] = []
  const extSet = new Set(exts.map(e => e.toLowerCase()))

  function walk(dir: string) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue
      const full = join(dir, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(full)
      } else if (stat.isFile()) {
        const ext = extname(name).slice(1).toLowerCase()
        if (extSet.has(ext)) results.push(full)
      }
    }
  }
  walk(root)
  return results
}

/** Create a unique temp directory for converted markdown. */
function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `madcat-ingest-${prefix}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Sanitize a filename for use as a markdown filename. */
function mdName(filePath: string, root: string): string {
  const rel = relative(root, filePath)
  return rel.replace(/[/\\]/g, "__").replace(/\.[^.]+$/, "") + ".md"
}

// ── HTML ingest ──

export const html = tool({
  description:
    "Ingest HTML files from a directory — convert to markdown via Rust NAPI, then index as docs. " +
    "Strips navigation, forms, and boilerplate. Great for scraped wikis and archived sites.",
  args: {
    path: tool.schema.string().describe("Directory containing HTML files to ingest"),
    project: tool.schema.string().optional().describe("Project name for the index"),

  },
  async execute(args) {
    const htmNode = await import("@kreuzberg/html-to-markdown-node")
    const convert = htmNode.default?.convert ?? htmNode.convert

    const files = findFiles(args.path, ["html", "htm"])
    if (files.length === 0) {
      return JSON.stringify({ error: "No HTML files found", path: args.path })
    }

    const tempDir = makeTempDir("html")
    let converted = 0
    let failed = 0
    const errors: string[] = []

    for (const file of files) {
      try {
        const html = readFileSync(file, "utf-8")
        // Preprocessing off by default — vintage HTML (TWiki, old forums)
        // wraps content in forms/tables that aggressive stripping kills.
        const result = convert(html, { preprocessing: { enabled: false } })
        let md = result.content ?? ""
        // Strip common boilerplate lines
        md = md
          .replace(/^---\ntitle:.*\n---\n*/m, "")
          .replace(/%HTTP_EQUIV_ON_VIEW%[^\n]*/g, "")
          .replace(/^\s*="" \/>\s*$/gm, "")
          .trim()
        if (md.trim().length > 20) {
          // Add source path as frontmatter for traceability
          const header = `<!-- source: ${relative(args.path, file)} -->\n\n`
          writeFileSync(join(tempDir, mdName(file, args.path)), header + md)
          converted++
        }
      } catch (err: any) {
        failed++
        if (errors.length < 10) errors.push(`${basename(file)}: ${err.message}`)
      }
    }

    // Index the converted markdown
    let indexResult = null
    if (converted > 0) {
      indexResult = await (await db()).indexDocs(tempDir, args.project ?? undefined)
    }

    // Cleanup temp dir
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch { /* best effort */ }

    return JSON.stringify({
      source: args.path,
      files_found: files.length,
      converted,
      failed,
      errors: errors.length > 0 ? errors : undefined,
      index: indexResult,
    }, null, 2)
  },
})

// ── PDF ingest ──

export const pdf = tool({
  description:
    "Ingest PDF files from a directory — extract text and convert to markdown via Rust NAPI, then index as docs. " +
    "Handles text-based PDFs without OCR. Good for datasheets, manuals, and guides.",
  args: {
    path: tool.schema.string().describe("Directory containing PDF files to ingest"),
    project: tool.schema.string().optional().describe("Project name for the index"),
  },
  async execute(args) {
    // Firecrawl: Rust NAPI, best quality. No linux-arm64 binary though.
    // Falls back gracefully — PDF ingest unavailable on ARM64 Linux.
    let processPdf: ((buf: Buffer) => { markdown?: string }) | null = null
    try {
      const pdfMod = await import("@firecrawl/pdf-inspector")
      processPdf = pdfMod.default?.processPdf ?? pdfMod.processPdf
    } catch {
      return JSON.stringify({
        error: "PDF ingest unavailable — @firecrawl/pdf-inspector has no binary for this platform",
        platform: `${process.platform}-${process.arch}`,
      })
    }

    const files = findFiles(args.path, ["pdf"])
    if (files.length === 0) {
      return JSON.stringify({ error: "No PDF files found", path: args.path })
    }

    const tempDir = makeTempDir("pdf")
    let converted = 0
    let failed = 0
    const errors: string[] = []

    for (const file of files) {
      try {
        const buf = readFileSync(file)
        const result = processPdf(buf)
        const md = result.markdown ?? ""
        if (md.trim().length > 20) {
          const header = `<!-- source: ${relative(args.path, file)} -->\n\n`
          writeFileSync(join(tempDir, mdName(file, args.path)), header + md)
          converted++
        }
      } catch (err: any) {
        failed++
        if (errors.length < 10) errors.push(`${basename(file)}: ${err.message}`)
      }
    }

    let indexResult = null
    if (converted > 0) {
      indexResult = await (await db()).indexDocs(tempDir, args.project ?? undefined)
    }

    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch { /* best effort */ }

    return JSON.stringify({
      source: args.path,
      files_found: files.length,
      converted,
      failed,
      errors: errors.length > 0 ? errors : undefined,
      index: indexResult,
    }, null, 2)
  },
})

// ── JSON ingest ──

export const json_docs = tool({
  description:
    "Ingest structured JSON files — serialize to readable markdown text, then index as docs. " +
    "Good for structured databases like ECU pinouts, component lists, and spec sheets.",
  args: {
    path: tool.schema.string().describe("Directory containing JSON files, or a single JSON file path"),
    project: tool.schema.string().optional().describe("Project name for the index"),
    description: tool.schema
      .string()
      .optional()
      .describe("Human description prepended to each file's content for context"),
  },
  async execute(args) {
    const stat = statSync(args.path)
    const files = stat.isDirectory()
      ? findFiles(args.path, ["json"])
      : [args.path]
    const root = stat.isDirectory() ? args.path : join(args.path, "..")

    // Filter out package.json, package-lock.json, tsconfig, etc.
    const dataFiles = files.filter((f) => {
      const name = basename(f).toLowerCase()
      return !name.startsWith("package") && !name.startsWith("tsconfig") && !name.startsWith(".")
    })

    if (dataFiles.length === 0) {
      return JSON.stringify({ error: "No data JSON files found", path: args.path })
    }

    const tempDir = makeTempDir("json")
    let converted = 0
    let failed = 0
    const errors: string[] = []

    for (const file of dataFiles) {
      try {
        const raw = readFileSync(file, "utf-8")
        const data = JSON.parse(raw)
        const md = jsonToMarkdown(data, basename(file), args.description)
        if (md.trim().length > 20) {
          const header = `<!-- source: ${relative(root, file)} -->\n\n`
          writeFileSync(join(tempDir, mdName(file, root)), header + md)
          converted++
        }
      } catch (err: any) {
        failed++
        if (errors.length < 10) errors.push(`${basename(file)}: ${err.message}`)
      }
    }

    let indexResult = null
    if (converted > 0) {
      indexResult = await (await db()).indexDocs(tempDir, args.project ?? undefined)
    }

    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch { /* best effort */ }

    return JSON.stringify({
      source: args.path,
      files_found: dataFiles.length,
      converted,
      failed,
      errors: errors.length > 0 ? errors : undefined,
      index: indexResult,
    }, null, 2)
  },
})

// ── JSON → Markdown renderer ──

function jsonToMarkdown(data: unknown, filename: string, description?: string): string {
  const lines: string[] = []
  lines.push(`# ${filename}`)
  if (description) lines.push("", description)
  lines.push("")
  renderValue(data, lines, 0)
  return lines.join("\n")
}

function renderValue(val: unknown, lines: string[], depth: number): void {
  if (val === null || val === undefined) return

  if (Array.isArray(val)) {
    for (const item of val) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        // Render object items as subsections or table rows
        const keys = Object.keys(item)
        const nameKey = keys.find((k) =>
          ["name", "title", "id", "function", "short", "label"].includes(k.toLowerCase()),
        )
        if (nameKey) {
          const heading = "#".repeat(Math.min(depth + 2, 6))
          lines.push(`${heading} ${(item as any)[nameKey]}`)
        }
        renderObject(item as Record<string, unknown>, lines, depth + 1)
        lines.push("")
      } else {
        lines.push(`- ${String(val)}`)
      }
    }
  } else if (typeof val === "object") {
    renderObject(val as Record<string, unknown>, lines, depth)
  } else {
    lines.push(String(val))
  }
}

function renderObject(obj: Record<string, unknown>, lines: string[], depth: number): void {
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue

    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      lines.push(`- **${key}**: ${val}`)
    } else if (Array.isArray(val) && val.length > 0 && typeof val[0] !== "object") {
      lines.push(`- **${key}**: ${val.join(", ")}`)
    } else if (Array.isArray(val) || typeof val === "object") {
      const heading = "#".repeat(Math.min(depth + 2, 6))
      lines.push("", `${heading} ${key}`, "")
      renderValue(val, lines, depth + 1)
    }
  }
}
