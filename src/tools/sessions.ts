/**
 * Session visibility tools — list, status, get, diff, children, search, ingest.
 */

import { tool } from "../lib/tool"
import { sdk, run } from "../lib/sdk.ts"
import { meshHosts, hostDescription } from "../lib/config.ts"
import { readLock } from "../lib/db.ts"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { homedir } from "node:os"
import { memoryStore } from "../lib/native.ts"
import { ulidTime } from "../lib/eems.ts"

const OPENCODE_DB = join(homedir(), ".local/share/opencode/opencode.db")

export const list = tool({
  description: "List opencode sessions on this server. Shows id, title, agent, model, cost, directory, and timestamps for each session.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    limit: tool.schema.number().optional().describe("Max sessions to return (default: 50)"),
    agent: tool.schema.string().optional().describe("Filter by agent name (e.g. core, phone, build)"),
    search: tool.schema.string().optional().describe("Title search term"),
    directory: tool.schema.string().optional().describe("Only sessions in this directory"),
    cursor: tool.schema.string().optional().describe("Pagination cursor from a previous response"),
  },
  async execute(args) {
    return run(async () => {
      const page = await sdk(args.host).session.list({
        limit: args.limit ?? 50,
        search: args.search,
        directory: args.directory,
        cursor: args.cursor,
      })
      let sessions = page.data
      if (args.agent) sessions = sessions.filter((s) => s.agent === args.agent)
      return {
        sessions: sessions.map((s) => ({
          id: s.id,
          title: s.title || "(untitled)",
          agent: s.agent || "",
          model: s.model?.id || "",
          cost: `$${(s.cost || 0).toFixed(4)}`,
          directory: s.location?.directory || "",
          parentID: s.parentID,
          created: s.time?.created ? new Date(s.time.created).toISOString() : null,
          updated: s.time?.updated ? new Date(s.time.updated).toISOString() : null,
        })),
        cursor: page.cursor?.next ?? undefined,
      }
    })
  },
})

export const status = tool({
  description:
    "Get live status for opencode sessions — running or idle." +
    " Returns every recent session with its explicit state, not just running ones." +
    " Includes title, agent, and model for context.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    limit: tool.schema.number().optional().describe("Max sessions to include (default: 50)"),
  },
  async execute(args) {
    return run(async () => {
      const client = sdk(args.host)
      const [active, page] = await Promise.all([
        client.session.active(),
        client.session.list({ limit: args.limit ?? 50 }),
      ])

      // Merge: every session gets an explicit state
      const merged: Record<string, any> = {}
      for (const s of page.data) {
        const state = active[s.id] ?? { type: "idle" }
        merged[s.id] = {
          ...state,
          title: s.title || "(untitled)",
          agent: s.agent || "",
          model: s.model?.id || "",
        }
      }
      // Include running sessions that fell outside the list page
      for (const [id, state] of Object.entries(active)) {
        if (!merged[id]) merged[id] = state
      }
      return merged
    })
  },
})

export const get = tool({
  description: "Get full details for a specific opencode session by its ID.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("Session ID (e.g. ses_xxx)"),
  },
  async execute(args) {
    return run(async () => sdk(args.host).session.get({ sessionID: args.id }))
  },
})

export const diff = tool({
  description: "Get file diffs (changes) made by an opencode session. Shows what files were modified and the patches.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("Session ID"),
    from: tool.schema.string().optional().describe("Start message ID (omit for session start)"),
    to: tool.schema.string().optional().describe("End message ID (omit for latest)"),
    context: tool.schema.number().optional().describe("Lines of diff context"),
  },
  async execute(args) {
    return run(async () =>
      sdk(args.host).session.diff({ sessionID: args.id, from: args.from, to: args.to, context: args.context }),
    )
  },
})

export const children = tool({
  description: "Get child/forked sessions of a parent session.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("Parent session ID"),
  },
  async execute(args) {
    return run(async () => (await sdk(args.host).session.list({ parentID: args.id })).data)
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Session Ingest — extract insights from opencode sessions into EEMS
// ─────────────────────────────────────────────────────────────────────────────

interface Turn {
  userContent: string
  assistantContent: string
  toolCalls: string[]
  toolResults: string[]
  timestamp: string | null
}

interface SessionData {
  id: string
  title: string
  project: string
  turns: Turn[]
  filesEdited: string[]
  commandsRun: string[]
}

/**
 * Extract session data from opencode.db
 */
function extractSessionData(sessionId: string): SessionData | null {
  const db = new Database(OPENCODE_DB, { readonly: true })
  try {
    // Get session metadata
    const session = db.query(`
      SELECT s.id, s.title, p.worktree as project
      FROM session s
      LEFT JOIN project p ON s.project_id = p.id
      WHERE s.id = ?
    `).get(sessionId) as any

    if (!session) return null

    // Get all messages for this session
    const messages = db.query(`
      SELECT id, data FROM message 
      WHERE session_id = ? 
      ORDER BY time_created ASC
    `).all(sessionId) as any[]

    // Get all parts for this session
    const parts = db.query(`
      SELECT message_id, data FROM part 
      WHERE session_id = ? 
      ORDER BY time_created ASC
    `).all(sessionId) as any[]

    // Group parts by message
    const partsByMessage: Record<string, any[]> = {}
    for (const part of parts) {
      const data = JSON.parse(part.data)
      if (!partsByMessage[part.message_id]) {
        partsByMessage[part.message_id] = []
      }
      partsByMessage[part.message_id].push(data)
    }

    // Build turns from messages
    const turns: Turn[] = []
    const filesEdited: Set<string> = new Set()
    const commandsRun: string[] = []

    let currentUserContent = ""
    let currentTimestamp: string | null = null

    for (const msg of messages) {
      const msgData = JSON.parse(msg.data)
      const msgParts = partsByMessage[msg.id] || []

      if (msgData.role === "user") {
        // Accumulate user content
        for (const part of msgParts) {
          if (part.type === "text" && part.text) {
            currentUserContent += part.text + "\n"
          }
        }
        if (msgData.time?.created) {
          currentTimestamp = new Date(msgData.time.created).toISOString()
        }
      } else if (msgData.role === "assistant" && currentUserContent) {
        // Build turn from accumulated user content + this assistant response
        let assistantContent = ""
        const toolCalls: string[] = []
        const toolResults: string[] = []

        for (const part of msgParts) {
          if (part.type === "text" && part.text) {
            assistantContent += part.text + "\n"
          } else if (part.type === "tool" && part.state) {
            const toolName = part.tool || "unknown"
            toolCalls.push(toolName)

            // Track files edited
            if (toolName === "edit" || toolName === "write") {
              const filePath = part.state.input?.filePath || part.state.input?.path
              if (filePath) filesEdited.add(filePath)
            }

            // Track commands run
            if (toolName === "bash" && part.state.input?.command) {
              commandsRun.push(part.state.input.command)
            }

            // Capture significant tool results (truncated)
            if (part.state.output && part.state.output.length < 2000) {
              toolResults.push(`[${toolName}]: ${part.state.output.slice(0, 500)}`)
            }
          }
        }

        if (assistantContent.trim() || toolCalls.length > 0) {
          turns.push({
            userContent: currentUserContent.trim(),
            assistantContent: assistantContent.trim(),
            toolCalls,
            toolResults,
            timestamp: currentTimestamp,
          })
        }

        // Reset for next turn
        currentUserContent = ""
        currentTimestamp = null
      }
    }

    return {
      id: session.id,
      title: session.title || "(untitled)",
      project: session.project || "/",
      turns,
      filesEdited: Array.from(filesEdited),
      commandsRun,
    }
  } finally {
    db.close()
  }
}

/**
 * Score a turn for memory-worthiness (port of madcat-os scorer)
 */
function scoreTurn(turn: Turn): number {
  const userLen = turn.userContent.length
  const asstLen = turn.assistantContent.length

  if (userLen < 10) return 0
  if (asstLen < 20 && turn.toolCalls.length === 0) return 0

  let score = 0

  // Substantive conversation
  if (userLen > 50) score += 0.2
  if (asstLen > 200) score += 0.2

  // Decision/preference signals
  if (/\b(prefer|always|never|don't|stop|instead|change|switch)\b/i.test(turn.userContent)) {
    score += 0.15
  }
  if (/\b(why|how|what.*(best|right|should))\b/i.test(turn.userContent)) {
    score += 0.15
  }
  if (/\b(decide|chose|pick|go with)\b/i.test(turn.userContent)) {
    score += 0.1
  }

  // Problem/solution signals
  if (/\b(solution|fix|issue|problem|error|bug)\b/i.test(turn.assistantContent)) {
    score += 0.15
  }
  if (/\b(because|reason|trade.?off|approach)\b/i.test(turn.assistantContent)) {
    score += 0.1
  }

  // Architecture/design signals
  if (/\b(architecture|design|pattern|schema|migration)\b/i.test(turn.assistantContent)) {
    score += 0.15
  }

  // Tool usage bonus
  if (turn.toolCalls.length > 0) score += 0.1
  if (turn.toolCalls.includes("edit") || turn.toolCalls.includes("write")) score += 0.1

  // Penalize slash commands, continuations
  if (/^\/\w+/.test(turn.userContent)) score -= 0.3
  if (/^(c|y|yes|no|continue|kill|test)\s*$/i.test(turn.userContent)) score -= 0.5

  return Math.max(0, Math.min(1, score))
}

/**
 * Format turn as memory content
 */
function formatMemory(turn: Turn, sessionTitle: string): string {
  const parts: string[] = []

  parts.push(`Q: ${turn.userContent}`)

  if (turn.assistantContent) {
    parts.push(`A: ${turn.assistantContent}`)
  }

  if (turn.toolCalls.length > 0) {
    parts.push(`Tools: ${turn.toolCalls.join(", ")}`)
  }

  const content = parts.join("\n\n")
  return content.length > 4000 ? content.slice(0, 4000) : content
}

/**
 * Derive subject from turn content
 */
function deriveSubject(turn: Turn, sessionTitle: string): string {
  // Use session title if meaningful
  if (sessionTitle && sessionTitle !== "(untitled)" && sessionTitle.length > 5) {
    return `session.${sessionTitle.slice(0, 60).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`
  }

  // Fall back to first sentence of user content
  const text = turn.userContent.trim()
  const first = text.split(/[.!?\n]/)[0]?.trim() || text
  const subject = first.slice(0, 80).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()
  return `session.${subject}`
}

export const ingest = tool({
  description:
    "Ingest insights from an opencode session into EEMS memory. " +
    "Extracts worthy turns (decisions, solutions, architecture discussions) and stores them. " +
    "Use dry_run=true to preview what would be stored without writing.",
  args: {
    id: tool.schema.string().describe("Session ID to ingest (e.g. ses_xxx)"),
    threshold: tool.schema.number().optional().describe("Minimum score for a turn to be stored (default: 0.3)"),
    dry_run: tool.schema.boolean().optional().describe("Preview without storing (default: false)"),
  },
  async execute(args) {
    return run(async () => {
      const threshold = args.threshold ?? 0.3
      const dryRun = args.dry_run ?? false

      const session = extractSessionData(args.id)
      if (!session) {
        return { error: `Session not found: ${args.id}` }
      }

      // Score all turns
      const scoredTurns = session.turns.map((turn) => ({
        turn,
        score: scoreTurn(turn),
      }))

      const worthyTurns = scoredTurns.filter((t) => t.score >= threshold)

      if (dryRun) {
        return {
          session: {
            id: session.id,
            title: session.title,
            project: session.project,
          },
          summary: {
            totalTurns: session.turns.length,
            worthyTurns: worthyTurns.length,
            filesEdited: session.filesEdited.length,
            commandsRun: session.commandsRun.length,
          },
          candidates: worthyTurns.map((t) => ({
            score: t.score.toFixed(2),
            subject: deriveSubject(t.turn, session.title),
            preview: t.turn.userContent.slice(0, 100) + (t.turn.userContent.length > 100 ? "..." : ""),
            toolCalls: t.turn.toolCalls,
          })),
          filesEdited: session.filesEdited.slice(0, 20),
        }
      }

      // Store to EEMS. store() dedups by content hash within (namespace,
      // subject) and returns the existing id — a ULID minted before this
      // run started means the memory was already there.
      const store = await memoryStore()
      const runStarted = Date.now()
      let stored = 0
      let skipped = 0

      for (const { turn, score } of worthyTurns) {
        const subject = deriveSubject(turn, session.title)
        const content = formatMemory(turn, session.title)

        const id = await store.store({
          subject,
          content,
          classification: "standard",
          confidence: score,
          namespace: "default",
          metadata: {
            source: "opencode_session_ingest",
            session_id: session.id,
            session_title: session.title,
            project: session.project,
            timestamp: turn.timestamp,
            tools: turn.toolCalls,
          },
        })
        if (ulidTime(id) < runStarted) skipped++
        else stored++
      }

      return {
        session: {
          id: session.id,
          title: session.title,
          project: session.project,
        },
        result: {
          totalTurns: session.turns.length,
          worthyTurns: worthyTurns.length,
          stored,
          skipped,
          filesEdited: session.filesEdited.length,
        },
      }
    })
  },
})

export const search = tool({
  description:
    "Search ALL sessions across ALL projects in the local opencode database. " +
    "Bypasses project scoping — finds sessions by title, agent, model, date, or cost. " +
    "Use when you don't remember which project a session belongs to.",
  args: {
    query: tool.schema.string().optional().describe("Search term for title (case-insensitive substring match)"),
    agent: tool.schema.string().optional().describe("Filter by agent name (e.g. build, explore, core)"),
    model: tool.schema.string().optional().describe("Filter by model (substring match, e.g. opus, sonnet)"),
    project: tool.schema.string().optional().describe("Filter by project path (substring match)"),
    minCost: tool.schema.number().optional().describe("Minimum cost in dollars"),
    maxCost: tool.schema.number().optional().describe("Maximum cost in dollars"),
    days: tool.schema.number().optional().describe("Only sessions from the last N days"),
    limit: tool.schema.number().optional().describe("Max results (default: 50)"),
  },
  async execute(args) {
    return run(async () => {
      const db = new Database(OPENCODE_DB, { readonly: true })
      try {
        const conditions: string[] = []
        const params: any[] = []

        if (args.query) {
          conditions.push("s.title LIKE ?")
          params.push(`%${args.query}%`)
        }
        if (args.agent) {
          conditions.push("s.agent LIKE ?")
          params.push(`%${args.agent}%`)
        }
        if (args.model) {
          conditions.push("s.model LIKE ?")
          params.push(`%${args.model}%`)
        }
        if (args.project) {
          conditions.push("p.worktree LIKE ?")
          params.push(`%${args.project}%`)
        }
        if (args.minCost !== undefined) {
          conditions.push("s.cost >= ?")
          params.push(args.minCost)
        }
        if (args.maxCost !== undefined) {
          conditions.push("s.cost <= ?")
          params.push(args.maxCost)
        }
        if (args.days) {
          const cutoff = Date.now() - args.days * 24 * 60 * 60 * 1000
          conditions.push("s.time_updated >= ?")
          params.push(cutoff)
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
        const limit = args.limit || 50
        params.push(limit)

        const sql = `
          SELECT 
            s.id,
            s.title,
            s.agent,
            s.model,
            s.cost,
            s.tokens_input,
            s.tokens_output,
            p.worktree as project,
            p.name as project_name,
            datetime(s.time_created/1000, 'unixepoch', 'localtime') as created,
            datetime(s.time_updated/1000, 'unixepoch', 'localtime') as updated
          FROM session s
          LEFT JOIN project p ON s.project_id = p.id
          ${where}
          ORDER BY s.time_updated DESC
          LIMIT ?
        `

        const rows = db.query(sql).all(...params) as any[]

        return rows.map((r) => {
          // Parse model JSON if present
          let modelStr = ""
          if (r.model) {
            try {
              const m = JSON.parse(r.model)
              modelStr = m.id || r.model
            } catch {
              modelStr = r.model
            }
          }

          return {
            id: r.id,
            title: r.title || "(untitled)",
            agent: r.agent || "",
            model: modelStr,
            cost: `$${(r.cost || 0).toFixed(2)}`,
            tokens: `${((r.tokens_input || 0) / 1000).toFixed(0)}k in / ${((r.tokens_output || 0) / 1000).toFixed(0)}k out`,
            project: r.project || "/",
            created: r.created,
            updated: r.updated,
          }
        })
      } finally {
        db.close()
      }
    })
  },
})
