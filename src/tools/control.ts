/**
 * Session control tools — abort, summarize, fork, create, update, delete,
 * revert, unrevert, shell, command.
 */

import { tool } from "../lib/tool"
import { sdk, run } from "../lib/sdk.ts"
import { hostDescription } from "../lib/config.ts"

export const abort = tool({
  description: "Interrupt a running turn in another opencode session. Use when a session is stuck or you need to interrupt it.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("Session ID to abort"),
  },
  async execute(args) {
    return run(async () => {
      const res = await sdk(args.host).session.interrupt({ sessionID: args.id })
      return { status: res.interrupted ? "interrupted" : "not-running", id: args.id }
    })
  },
})

export const summarize = tool({
  description:
    "Compact (summarize) an opencode session to reduce its context window usage." +
    " The summarization model is resolved server-side from the session's agent config.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("Session ID to compact"),
    queue: tool.schema.boolean().optional().describe("Queue behind pending prompts instead of compacting at the next step boundary"),
  },
  async execute(args) {
    return run(async () => {
      const inbox = await sdk(args.host).session.compact({
        sessionID: args.id,
        delivery: args.queue ? "queue" : "steer",
      })
      return { status: "compacting", id: args.id, inbox: inbox.id }
    })
  },
})

export const fork = tool({
  description: "Fork an opencode session, optionally before a specific message. Creates a new session with the conversation history up to that point.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("Session ID to fork"),
    messageId: tool.schema.string().optional().describe("Fork before this message ID (omit for latest)"),
  },
  async execute(args) {
    return run(async () => sdk(args.host).session.fork({ sessionID: args.id, before: args.messageId }))
  },
})

export const create = tool({
  description: "Create a new opencode session. Optionally set a title, agent, model, parent session, or working directory.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    title: tool.schema.string().optional().describe("Session title"),
    parentId: tool.schema.string().optional().describe("Parent session ID (for child sessions)"),
    agent: tool.schema.string().optional().describe("Agent to start the session with (e.g. core, build)"),
    model: tool.schema.string().optional().describe("Model as provider/model[#variant] (e.g. anthropic/claude-sonnet-4-6)"),
    directory: tool.schema.string().optional().describe("Working directory for the session (defaults to the serve's location)"),
  },
  async execute(args) {
    return run(async () =>
      sdk(args.host).session.create({
        title: args.title,
        parentID: args.parentId,
        agent: args.agent,
        model: parseModel(args.model),
        location: args.directory ? { directory: args.directory } : undefined,
      }),
    )
  },
})

export const update = tool({
  description: "Update an opencode session's properties. Currently supports changing the title.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("Session ID to update"),
    title: tool.schema.string().describe("New session title"),
  },
  async execute(args) {
    return run(async () => {
      await sdk(args.host).session.update({ sessionID: args.id, title: args.title })
      return { status: "updated", id: args.id, title: args.title }
    })
  },
})

export const remove = tool({
  description: "Delete an opencode session and all its messages, children, and data. Irreversible.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("Session ID to delete"),
  },
  async execute(args) {
    return run(async () => {
      await sdk(args.host).session.remove({ sessionID: args.id })
      return { status: "deleted", id: args.id }
    })
  },
})

export const revert = tool({
  description: "Stage a revert to a specific message in an opencode session. Undoes the message's effects; use control_unrevert to clear the staged revert.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("Session ID"),
    messageId: tool.schema.string().describe("Message ID to revert to"),
    files: tool.schema.boolean().optional().describe("Also revert file changes (default: true)"),
  },
  async execute(args) {
    return run(async () =>
      sdk(args.host).session.revert.stage({ sessionID: args.id, messageID: args.messageId, files: args.files }),
    )
  },
})

export const unrevert = tool({
  description: "Clear a staged revert, restoring all previously reverted messages in an opencode session.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("Session ID"),
  },
  async execute(args) {
    return run(async () => {
      await sdk(args.host).session.revert.clear({ sessionID: args.id })
      return { status: "cleared", id: args.id }
    })
  },
})

export const shell = tool({
  description: "Run a shell command inside another session. The output is recorded in that session's history.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("Session ID"),
    command: tool.schema.string().describe("Shell command to run"),
  },
  async execute(args) {
    return run(async () => {
      await sdk(args.host).session.shell({ sessionID: args.id, command: args.command })
      return { status: "started", id: args.id, command: args.command }
    })
  },
})

export const slash = tool({
  description: "Execute a slash command in another opencode session (e.g. /review, /init).",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("Session ID"),
    command: tool.schema.string().describe("Command name without slash (e.g. review, init)"),
    arguments: tool.schema.string().optional().describe("Command arguments"),
  },
  async execute(args) {
    return run(async () => {
      await sdk(args.host).session.command({ sessionID: args.id, name: args.command, text: args.arguments || "" })
      return { status: "dispatched", id: args.id, command: args.command }
    })
  },
})

/** Parse "provider/model[#variant]" into a V2 ModelRef. */
export function parseModel(ref?: string): { providerID: string; id: string; variant?: string } | undefined {
  if (!ref) return undefined
  const slash = ref.indexOf("/")
  if (slash <= 0) return undefined
  const providerID = ref.slice(0, slash)
  let id = ref.slice(slash + 1)
  let variant: string | undefined
  const hash = id.indexOf("#")
  if (hash > 0) {
    variant = id.slice(hash + 1)
    id = id.slice(0, hash)
  }
  return { providerID, id, variant }
}
