/**
 * EEMS memory tools — Postgres + pgvector, pure TypeScript (src/lib/eems.ts).
 * Hybrid recall (tsvector + vector cosine, RRF-fused), graph edges, dedup.
 *
 * Dual-DSN mode (EEMS_DSN_CORE + EEMS_DSN_DOUBLE): routes to per-agent
 * stores. Otherwise: the signed-in principal's instanced database.
 */

import { tool } from "../lib/tool"
import { memoryStoreForContext } from "../lib/native.ts"
import type { ToolContext } from "../lib/identity.ts"

/** Get the store for a tool call — routes by agent in dual-DSN mode. */
function db(context?: ToolContext) {
  return memoryStoreForContext(context)
}

// ── Memory Store ─────────────────────────────────────────────

export const store = tool({
  description:
    "Store persistent memories with subject and content. Embeds for semantic recall.",
  args: {
    subject: tool.schema.string().describe("Memory subject/category"),
    content: tool.schema.string().describe("Memory content to store"),
    classification: tool.schema
      .string()
      .optional()
      .describe("'standard' (default) or 'core' (immutable)"),
    confidence: tool.schema
      .number()
      .optional()
      .describe("Confidence 0.0-1.0 (default: 1.0)"),
    namespace: tool.schema
      .string()
      .optional()
      .describe("Namespace (default: 'default')"),
  },
  async execute(args, context: ToolContext) {
    const id = await (await db(context)).store({
      subject: args.subject,
      content: args.content,
      classification: args.classification ?? undefined,
      confidence: args.confidence ?? undefined,
      namespace: args.namespace ?? undefined,
    })
    return JSON.stringify({ id })
  },
})

// ── Memory Recall ────────────────────────────────────────────

export const recall = tool({
  description:
    "Recall memories by semantic similarity. Hybrid: full-text keyword + vector cosine fused via RRF.",
  args: {
    query: tool.schema.string().describe("Query to search for"),
    limit: tool.schema
      .number()
      .optional()
      .describe("Max results (default: 10)"),
    subject: tool.schema
      .string()
      .optional()
      .describe("Filter by subject"),
    namespace: tool.schema
      .string()
      .optional()
      .describe("Filter by namespace"),
  },
  async execute(args, context: ToolContext) {
    const hits = await (await db(context)).recall({
      query: args.query,
      limit: args.limit ?? undefined,
      subject: args.subject ?? undefined,
      namespace: args.namespace ?? undefined,
    })
    return JSON.stringify(hits, null, 2)
  },
})

// ── Memory Get ───────────────────────────────────────────────

export const get = tool({
  description: "Fetch full memory records by ID (no truncation).",
  args: {
    ids: tool.schema
      .array(tool.schema.string())
      .describe("Memory IDs to fetch (ULID strings)"),
  },
  async execute(args, context: ToolContext) {
    const mems = await (await db(context)).get(args.ids)
    return JSON.stringify(mems, null, 2)
  },
})

// ── Memory Forget ────────────────────────────────────────────

export const forget = tool({
  description: "Delete a specific memory entry by its ID.",
  args: {
    id: tool.schema.string().describe("Memory ID"),
  },
  async execute(args, context: ToolContext) {
    const existed = await (await db(context)).forget(args.id)
    return JSON.stringify({ deleted: existed })
  },
})

// ── Memory Classify ──────────────────────────────────────────

export const classify = tool({
  description:
    "Promote a memory to core classification. Immutable and irreversible.",
  args: {
    id: tool.schema.string().describe("Memory ID"),
    classification: tool.schema
      .string()
      .optional()
      .describe("Classification: 'standard' or 'core' (default: 'core')"),
  },
  async execute(args, context: ToolContext) {
    await (await db(context)).classify(args.id, args.classification ?? "core")
    return JSON.stringify({ classified: true })
  },
})

// ── Memory List Subjects ─────────────────────────────────────

export const list = tool({
  description:
    "List all memory subjects with entry counts. Overview of stored knowledge.",
  args: {
    namespace: tool.schema
      .string()
      .optional()
      .describe("Filter by namespace"),
  },
  async execute(args, context: ToolContext) {
    const subjects = await (await db(context)).listSubjects(args.namespace ?? undefined)
    return JSON.stringify(subjects, null, 2)
  },
})

// ── Memory Link ──────────────────────────────────────────────

export const link = tool({
  description:
    "Create a relationship edge between two memories. Relations: related_to, depends_on, contradicts, extends, supersedes.",
  args: {
    from_id: tool.schema.string().describe("Source memory ID"),
    to_id: tool.schema.string().describe("Target memory ID"),
    relation: tool.schema.string().describe("Relationship type"),
    weight: tool.schema
      .number()
      .optional()
      .describe("Edge weight 0.0-1.0 (default: 1.0)"),
  },
  async execute(args, context: ToolContext) {
    await (await db(context)).link({
      fromId: args.from_id,
      toId: args.to_id,
      relation: args.relation,
      weight: args.weight ?? undefined,
    })
    return JSON.stringify({ linked: true })
  },
})

// ── Memory Graph ─────────────────────────────────────────────

export const graph = tool({
  description:
    "Explore memory graph neighborhood. Shows connected memories up to N hops.",
  args: {
    id: tool.schema.string().describe("Memory ID to explore from"),
    depth: tool.schema
      .number()
      .optional()
      .describe("Max traversal depth (default: 2)"),
  },
  async execute(args, context: ToolContext) {
    const nodes = await (await db(context)).graph(args.id, args.depth ?? 2)
    return JSON.stringify(nodes, null, 2)
  },
})
