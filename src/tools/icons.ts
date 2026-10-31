/**
 * macOS Icons API — search and browse community-sourced macOS app icons.
 * Powered by macosicons.com. Returns .icns download URLs, preview PNGs, and metadata.
 * API key via MACOSICONS_API_KEY env var.
 */

import { tool } from "../lib/tool"

const API_KEY = process.env.MACOSICONS_API_KEY
const BASE = "https://api.macosicons.com/api/v1"

interface IconHit {
  appName: string
  objectID: string
  icnsUrl?: string
  lowResPngUrl?: string
  iOSUrl?: string
  downloads?: number
  usersName?: string
  credit?: string
  uploadedBy?: string
  timeStamp?: number
}

interface Category {
  objectId: string
  CategoryName: string
}

async function api(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ data?: any; error?: string }> {
  if (!API_KEY) return { error: "MACOSICONS_API_KEY not set" }
  try {
    const headers: Record<string, string> = {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
    }
    const init: RequestInit = { method: opts.method ?? "GET", headers }
    if (opts.body) init.body = JSON.stringify(opts.body)
    const res = await fetch(`${BASE}${path}`, init)
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return { error: `HTTP ${res.status}: ${text || res.statusText}` }
    }
    return { data: await res.json() }
  } catch (e: any) {
    return { error: `Request failed: ${e?.message || e}` }
  }
}

function formatHit(hit: IconHit, i: number): string {
  const lines = [`${i + 1}. ${hit.appName} (${hit.downloads ?? 0} downloads)`]
  if (hit.icnsUrl) lines.push(`   icns: ${hit.icnsUrl}`)
  if (hit.lowResPngUrl) lines.push(`   preview: ${hit.lowResPngUrl}`)
  if (hit.usersName) lines.push(`   by: ${hit.usersName}`)
  if (hit.objectID) lines.push(`   id: ${hit.objectID}`)
  return lines.join("\n")
}

export const search = tool({
  description:
    "Search macOS app icons by name or keyword. Returns icon URLs (.icns for native macOS, " +
    "PNG previews), download counts, and creator info. Use the .icns URL to download " +
    "replacement icons for macOS apps.",
  args: {
    query: tool.schema.string().min(1).describe("Search query (app name or keyword)"),
    count: tool.schema.number().optional().describe("Results per page (1-50, default: 10)"),
    page: tool.schema.number().optional().describe("Page number (default: 1)"),
  },
  async execute(args) {
    const { data, error } = await api("/search", {
      method: "POST",
      body: {
        query: args.query,
        searchOptions: {
          hitsPerPage: args.count ?? 10,
          page: args.page ?? 1,
        },
      },
    })
    if (error) return `macOS Icons error: ${error}`
    const hits: IconHit[] = data?.hits ?? []
    if (!hits.length) return `No icons found for "${args.query}".`
    const total = data?.nbHits ?? hits.length
    const pages = data?.nbPages ?? 1
    const header = `Found ${total} icons for "${args.query}" (page ${args.page ?? 1}/${pages}):\n`
    return header + hits.map((h, i) => formatHit(h, i)).join("\n\n")
  },
})

export const categories = tool({
  description: "List all icon categories available on macosicons.com.",
  args: {},
  async execute() {
    const { data, error } = await api("/search/getCategories")
    if (error) return `macOS Icons error: ${error}`
    const cats: Category[] = data ?? []
    if (!cats.length) return "No categories returned."
    return cats.map((c) => `• ${c.CategoryName} (${c.objectId})`).join("\n")
  },
})

export const download = tool({
  description:
    "Download a macOS icon (.icns) file to a local path. Provide the icns URL from a search result " +
    "and an output path. Returns the saved file path on success.",
  args: {
    url: tool.schema.string().url().describe("The .icns URL to download"),
    output: tool.schema.string().describe("Local file path to save to (e.g. /tmp/chrome.icns)"),
  },
  async execute(args) {
    try {
      const res = await fetch(args.url)
      if (!res.ok) return `Download failed: HTTP ${res.status}`
      const buf = await res.arrayBuffer()
      const { writeFileSync } = await import("fs")
      writeFileSync(args.output, Buffer.from(buf))
      const kb = Math.round(buf.byteLength / 1024)
      return `Saved ${kb} KB to ${args.output}`
    } catch (e: any) {
      return `Download error: ${e?.message || e}`
    }
  },
})
