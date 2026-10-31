/**
 * Brave Web Search API — search the web from Brave's independent index.
 * Requires BRAVE_API_KEY env var.
 */

import { tool } from "../lib/tool"

const API_KEY = process.env.BRAVE_API_KEY
const BASE_URL = "https://api.search.brave.com/res/v1/web/search"

async function request(
  params: Record<string, string>
): Promise<{ data?: any; error?: string }> {
  if (!API_KEY) return { error: "BRAVE_API_KEY not set" }

  const url = new URL(BASE_URL)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  try {
    const res = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": API_KEY,
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return { error: `HTTP ${res.status}: ${text || res.statusText}` }
    }
    return { data: await res.json() }
  } catch (e: any) {
    return { error: `Request failed: ${e?.message || e}` }
  }
}

function format(data: any): string {
  const lines: string[] = []

  if (data.web?.results?.length) {
    lines.push("=== Web Results ===\n")
    for (const [i, r] of data.web.results.entries()) {
      lines.push(`${i + 1}. ${r.title}`)
      lines.push(`   ${r.url}`)
      lines.push(`   ${r.description}`)
      if (r.extra_snippets?.length) {
        for (const s of r.extra_snippets) lines.push(`   • ${s}`)
      }
      lines.push("")
    }
  }

  if (data.news?.results?.length) {
    lines.push("=== News ===\n")
    for (const [i, r] of data.news.results.slice(0, 5).entries()) {
      lines.push(`${i + 1}. ${r.title}`)
      lines.push(`   ${r.url}`)
      if (r.description) lines.push(`   ${r.description}`)
      lines.push("")
    }
  }

  if (data.videos?.results?.length) {
    lines.push("=== Videos ===\n")
    for (const [i, r] of data.videos.results.slice(0, 3).entries()) {
      lines.push(`${i + 1}. ${r.title}`)
      lines.push(`   ${r.url}`)
      lines.push("")
    }
  }

  if (data.discussions?.results?.length) {
    lines.push("=== Discussions ===\n")
    for (const [i, r] of data.discussions.results.slice(0, 3).entries()) {
      lines.push(`${i + 1}. ${r.title}`)
      lines.push(`   ${r.url}`)
      lines.push("")
    }
  }

  if (data.faq?.results?.length) {
    lines.push("=== FAQ ===\n")
    for (const [i, r] of data.faq.results.slice(0, 3).entries()) {
      lines.push(`Q: ${r.question}`)
      lines.push(`A: ${r.answer}`)
      lines.push(`   ${r.url}`)
      lines.push("")
    }
  }

  return lines.length ? lines.join("\n") : "No results found."
}

export const search = tool({
  description:
    "Search the web using Brave Search. Returns web results, news, videos, discussions, and FAQs. " +
    "Supports freshness filters (pd/pw/pm/py) and result type filtering.",
  args: {
    query: tool.schema.string().describe("Search query (max 400 chars)"),
    count: tool.schema.number().optional().describe("Number of results (1-20, default: 5)"),
    freshness: tool.schema.string().optional().describe("Time filter: pd/pw/pm/py or YYYY-MM-DDtoYYYY-MM-DD"),
    result_filter: tool.schema.string().optional().describe("Comma-separated: web,news,videos,discussions,faq,infobox"),
  },
  async execute(args) {
    if (args.query.length > 400) return "Error: query exceeds 400 char limit"

    const params: Record<string, string> = {
      q: args.query,
      count: String(args.count ?? 5),
    }
    if (args.freshness) params.freshness = args.freshness
    if (args.result_filter) params.result_filter = args.result_filter

    const { data, error } = await request(params)
    if (error) return `Brave Search error: ${error}`
    if (!data) return "No data returned"

    return format(data)
  },
})
