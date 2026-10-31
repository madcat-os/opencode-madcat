/**
 * Job search aggregator — multi-provider job board search.
 *
 * Provider scaffold: each provider implements JobProvider and is registered
 * in PROVIDERS. Adding a new source = one interface impl + one map entry.
 *
 * Current providers:
 *   - waas: Y Combinator's Work at a Startup (Algolia API, requires Firefox SSO)
 *   - hn:   Hacker News "Who is Hiring?" threads (Algolia, public, no auth)
 *   - jjit: Just Join IT — Poland's #1 IT job board (JSON API, public, no auth)
 *   - nfj:  NoFluffJobs — Polish IT board with salary ranges (JSON API, public, no auth)
 */

import { tool } from "../lib/tool"
import { cookie } from "../lib/firefox.ts"

// ── Types ────────────────────────────────────────────────────

interface JobHit {
  id: string
  title: string
  company: string
  url: string
  remote: string
  location: string
  salary: string
  skills: string[]
  experience: string
  type: string
  description: string
  source: string
  extra: Record<string, string>
}

interface SearchOpts {
  query: string
  remote?: boolean
  limit: number
}

interface JobProvider {
  name: string
  search(opts: SearchOpts): Promise<JobHit[]>
}

// ── Formatting ───────────────────────────────────────────────

function formatHits(hits: JobHit[], verbose: boolean): string {
  if (!hits.length) return "No results found."

  const lines: string[] = []
  for (const [i, h] of hits.entries()) {
    lines.push(`${i + 1}. ${h.title} @ ${h.company}`)
    const meta = [h.remote, h.type, h.experience, h.salary].filter(Boolean)
    if (meta.length) lines.push(`   ${meta.join(" | ")}`)
    if (h.skills.length) lines.push(`   Skills: ${h.skills.join(", ")}`)
    if (h.location) lines.push(`   Location: ${h.location}`)
    if (h.url) lines.push(`   ${h.url}`)
    for (const [k, v] of Object.entries(h.extra)) {
      lines.push(`   ${k}: ${v}`)
    }
    if (verbose && h.description) {
      const desc = h.description.slice(0, 500).replace(/\n/g, " ").trim()
      lines.push(`   ${desc}${h.description.length > 500 ? "..." : ""}`)
    }
    lines.push("")
  }
  return lines.join("\n")
}

// ── Provider: Work at a Startup (YC) ─────────────────────────

const WAAS_APP_ID = "45BWZJ1SGC"
const WAAS_INDEX = "WaaSPublicCompanyJob_created_at_desc_production"
const WAAS_AGENT = "Algolia for JavaScript (3.35.1); Browser"

async function waasAlgoliaKey(): Promise<string | null> {
  const sso = cookie("_sso.key", "%workatastartup%")
  if (!sso) return null

  try {
    const resp = await fetch("https://www.workatastartup.com/jobs", {
      headers: {
        Cookie: `_sso.key=${sso}`,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:138.0) Gecko/20100101 Firefox/138.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    })
    const html = await resp.text()
    const match = html.match(/"key":"([^"]+)"/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

// Cache the key for the session (it's user-scoped, changes rarely)
let _waasKeyCache: string | null = null

async function waasKey(): Promise<string> {
  if (_waasKeyCache) return _waasKeyCache
  const key = await waasAlgoliaKey()
  if (!key) throw new Error("WAAS auth failed — log into workatastartup.com in Firefox first")
  _waasKeyCache = key
  return key
}

const waasProvider: JobProvider = {
  name: "waas",

  async search(opts) {
    const key = await waasKey()

    const filterParts = [
      "(role:eng)",
      "(us_visa_required:none OR us_visa_required:possible)",
    ]
    if (opts.remote) filterParts.push("(remote:only OR remote:yes)")

    const params = new URLSearchParams({
      query: opts.query,
      page: "0",
      filters: filterParts.join(" AND "),
      attributesToRetrieve: '["*"]',
      hitsPerPage: String(opts.limit),
      clickAnalytics: "true",
      distinct: "true",
    })

    const resp = await fetch(
      `https://${WAAS_APP_ID}-dsn.algolia.net/1/indexes/*/queries`,
      {
        method: "POST",
        headers: {
          "x-algolia-application-id": WAAS_APP_ID,
          "x-algolia-api-key": key,
          "x-algolia-agent": WAAS_AGENT,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requests: [{ indexName: WAAS_INDEX, params: params.toString() }],
        }),
      },
    )

    const data = (await resp.json()) as any
    if (!data.results?.[0]?.hits) return []

    return data.results[0].hits.map((h: any) => {
      const remoteLbl = { only: "REMOTE", yes: "HYBRID/REMOTE", no: "ONSITE" }[h.remote as string] ?? h.remote
      const locs = (h.locations_for_search ?? []).slice(0, 3).join(", ")
      const stage = h.company_waas_stage ?? ""
      const teamSize = h.company_team_size ? `${h.company_team_size} people` : ""

      return {
        id: String(h.objectID),
        title: h.title,
        company: h.company_name,
        url: `https://www.workatastartup.com/jobs/${h.objectID}`,
        remote: remoteLbl,
        location: locs,
        salary: h.has_salary ? "salary listed" : "",
        skills: h.skills ?? [],
        experience: h.min_experience != null ? `${h.min_experience}+ yrs` : "",
        type: h.job_type ?? "",
        description: h.description ?? "",
        source: "waas",
        extra: {
          ...(stage && { Stage: stage }),
          ...(teamSize && { Team: teamSize }),
          ...(h.company_description && { Company: h.company_description }),
        },
      } satisfies JobHit
    })
  },
}

// ── Provider: Hacker News "Who is Hiring?" ───────────────────

const hnProvider: JobProvider = {
  name: "hn",

  async search(opts) {
    // Step 1: find the latest "Who is hiring?" thread
    const threadResp = await fetch(
      `https://hn.algolia.com/api/v1/search_by_date?` +
        new URLSearchParams({
          query: '"Who is hiring"',
          tags: "story",
          hitsPerPage: "1",
        }),
    )
    const threadData = (await threadResp.json()) as any
    const storyId = threadData.hits?.[0]?.objectID
    if (!storyId) return []

    const storyTitle = threadData.hits[0].title ?? "Who is hiring?"

    // Step 2: search comments in that thread
    const resp = await fetch(
      `https://hn.algolia.com/api/v1/search?` +
        new URLSearchParams({
          query: opts.query,
          tags: `comment,story_${storyId}`,
          hitsPerPage: String(opts.limit),
        }),
    )
    const data = (await resp.json()) as any
    if (!data.hits?.length) return []

    return data.hits.map((h: any) => {
      const text: string = (h.comment_text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()

      // Try to extract company/role from first line
      const firstLine = text.slice(0, 200)

      // Detect remote
      const isRemote = /\bREMOTE\b/i.test(firstLine)
      const remoteLbl = isRemote ? "REMOTE" : ""

      // Try salary extraction
      const salaryMatch = text.match(/\$[\d,]+k?\s*[-–]\s*\$?[\d,]+k?/i)
      const salary = salaryMatch?.[0] ?? ""

      return {
        id: String(h.objectID),
        title: firstLine.slice(0, 120),
        company: h.author ?? "",
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        remote: remoteLbl,
        location: "",
        salary,
        skills: [],
        experience: "",
        type: "",
        description: text,
        source: "hn",
        extra: { Thread: storyTitle },
      } satisfies JobHit
    })
  },
}

// ── Provider: Just Join IT ───────────────────────────────────

const JJIT_API = "https://api.justjoin.it/v2/user-panel/offers"

const jjitProvider: JobProvider = {
  name: "jjit",

  async search(opts) {
    // JJIT v2 API uses skills[]=ExactName (case-sensitive display names)
    const skillMap: Record<string, string> = {
      ruby: "Ruby", rails: "Ruby on Rails", python: "Python",
      rust: "Rust", typescript: "TypeScript", javascript: "JavaScript",
      go: "Go", elixir: "Elixir", java: "Java", kotlin: "Kotlin",
      react: "React", node: "Node.js", docker: "Docker",
      kubernetes: "Kubernetes", aws: "AWS", postgresql: "PostgreSQL",
      redis: "Redis", graphql: "GraphQL",
      ai: "LLMs", ml: "Machine Learning", llm: "LLMs", rag: "RAG",
    }

    const queryWords = opts.query.toLowerCase().split(/\s+/)
    const skills = [...new Set(queryWords.map((w) => skillMap[w]).filter(Boolean))]

    // Build URL with array params (skills[] appears multiple times)
    const params = new URLSearchParams({
      page: "1",
      sortBy: "newest",
      orderBy: "DESC",
      perPage: String(opts.limit),
      salaryCurrencies: "PLN",
    })
    for (const skill of skills) params.append("skills[]", skill)
    if (opts.remote) params.set("workplaceType", "remote")

    const resp = await fetch(`${JJIT_API}?${params}`, {
      headers: { Accept: "application/json", Version: "2" },
    })
    if (!resp.ok) return []

    const data = (await resp.json()) as any
    if (!data.data?.length) return []

    return data.data.map((h: any) => {
      const emp = h.employmentTypes?.[0]
      let salary = ""
      if (emp?.from != null && emp?.to != null) {
        const unit = emp.unit === "hour" ? "/hr" : emp.unit === "month" ? "/mo" : ""
        const cur = (emp.currency ?? "pln").toUpperCase()
        salary = `${emp.from}-${emp.to} ${cur}${unit} (${emp.type ?? "?"})`
      }

      const remoteLbl = {
        remote: "REMOTE", partly_remote: "HYBRID", office: "ONSITE",
      }[h.workplaceType as string] ?? h.workplaceType ?? ""

      const locs = (h.multilocation ?? [])
        .map((l: any) => l.city)
        .filter(Boolean)
        .slice(0, 3)
        .join(", ")

      const skills = [
        ...(h.requiredSkills ?? []).map((s: any) => s.name ?? s),
        ...(h.niceToHaveSkills ?? []).map((s: any) => s.name ?? s),
      ].filter(Boolean)

      const expMap: Record<string, string> = {
        junior: "junior", mid: "mid", senior: "senior", lead: "lead",
      }
      const exp = expMap[h.experienceLevel] ?? h.experienceLevel ?? ""

      return {
        id: h.guid ?? h.slug ?? "",
        title: h.title,
        company: h.companyName ?? "",
        url: `https://justjoin.it/offers/${h.slug}`,
        remote: remoteLbl,
        location: locs || h.city || "",
        salary,
        skills,
        experience: exp,
        type: h.workingTime === "full_time" ? "fulltime" : h.workingTime ?? "",
        description: "",
        source: "jjit",
        extra: {},
      } satisfies JobHit
    })
  },
}

// ── Provider: NoFluffJobs ────────────────────────────────────

const NFJ_API = "https://nofluffjobs.com/api/posting"

const nfjProvider: JobProvider = {
  name: "nfj",

  async search(opts) {
    // NFJ uses criteria params: requirement=X, seniority=Y, city=Z
    // Map query keywords to NFJ requirement values
    const requirementMap: Record<string, string> = {
      ruby: "Ruby on Rails", rails: "Ruby on Rails", python: "Python",
      rust: "Rust", typescript: "TypeScript", javascript: "JavaScript",
      go: "Golang", java: "Java", kotlin: "Kotlin", elixir: "Elixir",
      react: "React", node: "Node.js", docker: "Docker",
      kubernetes: "Kubernetes", aws: "AWS",
      ai: "Machine Learning", ml: "Machine Learning",
      llm: "Machine Learning",
    }

    const queryWords = opts.query.toLowerCase().split(/\s+/)
    const requirements = [...new Set(
      queryWords.map((w) => requirementMap[w]).filter(Boolean),
    )]

    const params = new URLSearchParams()
    for (const req of requirements) {
      params.append("criteria", `requirement=${req}`)
    }
    // Default to Senior if not specified
    if (!queryWords.some((w) => ["junior", "mid", "senior"].includes(w))) {
      params.append("criteria", "seniority=Senior")
    }
    if (opts.remote) {
      params.append("criteria", "city=remote")
    }

    const resp = await fetch(`${NFJ_API}?${params}`, {
      headers: { Accept: "application/json" },
    })
    if (!resp.ok) return []

    const data = (await resp.json()) as any
    const postings = data.postings ?? []

    // Filter by query keywords in title/tech (NFJ API is broad)
    const filtered = requirements.length
      ? postings.filter((p: any) => {
          const combined = `${p.title ?? ""} ${p.technology ?? ""}`.toLowerCase()
          return queryWords.some((w) => combined.includes(w))
        })
      : postings

    // Dedup by company+title (NFJ lists the same remote job per voivodeship)
    const seen = new Set<string>()
    const deduped = filtered.filter((p: any) => {
      const key = `${(p.name ?? "").toLowerCase()}|${(p.title ?? "").toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    return deduped.slice(0, opts.limit).map((p: any) => {
      const sal = p.salary ?? {}
      let salary = ""
      if (sal.from != null && sal.to != null) {
        salary = `${sal.from}-${sal.to} ${sal.currency ?? "PLN"}`
        if (sal.type) salary += ` (${sal.type})`
      }

      const loc = p.location ?? {}
      const isRemote = loc.fullyRemote === true
      const remoteLbl = isRemote ? "REMOTE" : ""
      const places = (loc.places ?? [])
        .map((l: any) => l.city)
        .filter(Boolean)
        .slice(0, 3)
        .join(", ")

      const seniority = Array.isArray(p.seniority)
        ? p.seniority.join(", ")
        : p.seniority ?? ""

      return {
        id: p.id ?? p.url ?? "",
        title: p.title ?? "",
        company: p.name ?? "",
        url: `https://nofluffjobs.com/pl/job/${p.url ?? p.id}`,
        remote: remoteLbl,
        location: isRemote ? "Remote" : places,
        salary,
        skills: [p.technology].filter(Boolean),
        experience: seniority,
        type: "",
        description: "",
        source: "nfj",
        extra: {},
      } satisfies JobHit
    })
  },
}

// ── Provider registry ────────────────────────────────────────

const PROVIDERS: Record<string, JobProvider> = {
  waas: waasProvider,
  hn: hnProvider,
  jjit: jjitProvider,
  nfj: nfjProvider,
}

const PROVIDER_LIST = Object.keys(PROVIDERS).join(", ")

// ── Exported tools ───────────────────────────────────────────

export const search = tool({
  description:
    `Search job boards for openings. Providers: ${PROVIDER_LIST}. ` +
    "WAAS = Y Combinator startups (requires Firefox login). " +
    "HN = Hacker News Who is Hiring threads (public). " +
    "JJIT = Just Join IT, Poland's #1 IT job board (public). " +
    "NFJ = NoFluffJobs, Polish IT board with salary ranges (public). " +
    "Omit provider to search all sources.",
  args: {
    query: tool.schema.string().describe("Search keywords (e.g. 'ruby rails', 'senior backend')"),
    provider: tool.schema
      .string()
      .optional()
      .describe(`Provider to search: ${PROVIDER_LIST}, or omit for all`),
    remote: tool.schema.boolean().optional().describe("Filter for remote-friendly roles only"),
    limit: tool.schema.number().optional().describe("Max results per provider (default: 10)"),
    verbose: tool.schema.boolean().optional().describe("Include job description text (default: false)"),
  },
  async execute(args) {
    const limit = args.limit ?? 10
    const verbose = args.verbose ?? false
    const opts: SearchOpts = { query: args.query, remote: args.remote, limit }

    const targets = args.provider
      ? [PROVIDERS[args.provider]].filter(Boolean)
      : Object.values(PROVIDERS)

    if (!targets.length) {
      return `Unknown provider '${args.provider}'. Available: ${PROVIDER_LIST}`
    }

    const sections: string[] = []

    for (const provider of targets) {
      try {
        const hits = await provider.search(opts)
        const header = `=== ${provider.name.toUpperCase()} (${hits.length} results) ===`
        sections.push(`${header}\n\n${formatHits(hits, verbose)}`)
      } catch (e: any) {
        sections.push(`=== ${provider.name.toUpperCase()} ===\nError: ${e?.message ?? e}`)
      }
    }

    return sections.join("\n")
  },
})

export const providers = tool({
  description: "List available job search providers and their status.",
  args: {},
  async execute() {
    const lines: string[] = ["Available job search providers:\n"]

    for (const [id, p] of Object.entries(PROVIDERS)) {
      let status = "available"
      if (id === "waas") {
        const sso = cookie("_sso.key", "%workatastartup%")
        status = sso ? "authenticated (Firefox SSO)" : "not authenticated — log into workatastartup.com in Firefox"
      }
      lines.push(`  ${id}: ${p.name} — ${status}`)
    }

    return lines.join("\n")
  },
})
