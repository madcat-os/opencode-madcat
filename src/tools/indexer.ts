/**
 * Code and documentation indexer — Postgres + pgvector, pure TypeScript
 * (src/lib/eems.ts). Walk, chunk, embed via the [embedding] endpoint, store.
 */

import { tool } from "../lib/tool"
import { codeIndex } from "../lib/native.ts"

// Alias for backward compat within this file
const db = codeIndex

/**
 * Index code files
 */
export const code = tool({
  description: "Index code files in a given path",
  args: {
    path: tool.schema.string().describe("Path to index code files from"),
    project: tool.schema.string().optional().describe("Project name for the index")
  },
  async execute(args) {
    const result = await (await db()).indexCode(args.path, args.project ?? undefined)
    return JSON.stringify(result, null, 2)
  }
})

/**
 * Index documentation files
 */
export const docs = tool({
  description: "Index documentation files in a given path",
  args: {
    path: tool.schema.string().describe("Path to index documentation from"),
    project: tool.schema.string().optional().describe("Project name for the index")
  },
  async execute(args) {
    const result = await (await db()).indexDocs(args.path, args.project ?? undefined)
    return JSON.stringify(result, null, 2)
  }
})

/**
 * Search indexed content
 */
export const search = tool({
  description: "Semantic search across indexed code and documentation",
  args: {
    query: tool.schema.string().describe("Search query"),
    limit: tool.schema.number().optional().describe("Maximum results to return")
  },
  async execute(args) {
    const hits = await (await db()).search(args.query, undefined, args.limit ?? undefined)
    return JSON.stringify({
      results: hits.map((h: any) => ({
        type: h.chunk.language ? "code" : "docs",
        id: h.chunk.id,
        path: h.chunk.filePath,
        content: h.chunk.content,
        project: h.chunk.repo,
        distance: h.score,
      }))
    }, null, 2)
  }
})

/**
 * Show index status
 */
export const status = tool({
  description: "Show current index status and statistics",
  args: {},
  async execute() {
    const stats = await (await db()).status()
    return JSON.stringify(stats, null, 2)
  }
})

/**
 * Clear index
 */
export const clear = tool({
  description:
    "Clear indexed content. Optionally filter by type (code/docs) and/or repo name.",
  args: {
    type_filter: tool.schema
      .string()
      .optional()
      .describe("Filter: 'code', 'docs', or omit for both"),
    repo: tool.schema
      .string()
      .optional()
      .describe("Clear only this repo (e.g. 'madcat-plugin'). Omit to clear all."),
  },
  async execute(args) {
    await (await db()).clear(args.type_filter ?? undefined, args.repo ?? undefined)
    return JSON.stringify({ success: true }, null, 2)
  }
})
