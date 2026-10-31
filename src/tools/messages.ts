/**
 * Message tools — read history, send prompts to other sessions.
 *
 * prompt and prompt_async auto-inject a <caller>/<dispatch> header
 * using the tool context (sessionID, agent) so the target agent
 * knows who started it and where to report back.
 */

import { tool } from "../lib/tool"
import { sdk, run, type OpenCodeClient } from "../lib/sdk.ts"
import { hostDescription } from "../lib/config.ts"
import { buildCallerHeader, type ToolContext } from "../lib/identity"
import { parseModel } from "./control"

type Message = Awaited<ReturnType<OpenCodeClient["message"]["list"]>>["data"][number]

function summarize(msg: Message): Record<string, any> {
  const out: Record<string, any> = {
    id: msg.id,
    role: msg.type,
    created: msg.time?.created ? new Date(msg.time.created).toISOString() : null,
  }
  switch (msg.type) {
    case "user":
    case "synthetic":
    case "system":
      out.text = msg.text
      break
    case "assistant": {
      const text = msg.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n")
      const toolCalls = msg.content
        .filter((c) => c.type === "tool")
        .map((c) => ({ tool: (c as { name: string }).name, state: (c as { state: { status?: string } }).state?.status }))
      out.text = text || null
      if (toolCalls.length > 0) out.toolCalls = toolCalls
      out.agent = msg.agent
      out.model = msg.model?.id
      out.provider = msg.model?.providerID
      if (msg.cost) out.cost = `$${msg.cost.toFixed(4)}`
      if (msg.tokens) out.tokens = { input: msg.tokens.input, output: msg.tokens.output }
      if (msg.error) out.error = msg.error
      if (msg.finish) out.finish = msg.finish
      break
    }
    case "shell":
      out.command = msg.command
      out.status = msg.status
      out.text = msg.output?.output ?? null
      break
    default:
      break
  }
  return out
}

export const read = tool({
  description:
    "Read message history from an opencode session. Returns messages with role, text, tool calls, and timestamps, newest first." +
    " Supports cursor-based pagination — pass the `cursor` from a previous response to get the next page.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("Session ID"),
    limit: tool.schema.number().optional().describe("Max messages to return (default: 20)"),
    cursor: tool.schema.string().optional().describe("Pagination cursor from a previous response (fetches next page)"),
  },
  async execute(args) {
    return run(async () => {
      const page = await sdk(args.host).message.list({
        sessionID: args.id,
        limit: args.limit || 20,
        order: "desc",
        cursor: args.cursor,
      })
      const messages = page.data.map(summarize)
      const cursor = page.cursor?.next ?? undefined
      return { messages, cursor, has_more: !!cursor, count: messages.length }
    })
  },
})

async function applyOverrides(client: OpenCodeClient, sessionID: string, agent?: string, model?: string) {
  if (agent) await client.session.switchAgent({ sessionID, agent })
  const ref = parseModel(model)
  if (ref) await client.session.switchModel({ sessionID, model: ref })
}

async function lastAssistantText(client: OpenCodeClient, sessionID: string): Promise<{ text: string; id?: string }> {
  const page = await client.message.list({ sessionID, limit: 5, order: "desc", type: "assistant" })
  const last = page.data[0]
  if (!last || last.type !== "assistant") return { text: "(no assistant response)" }
  const text = last.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n")
  return { text: text || "(no text in response)", id: last.id }
}

export const prompt = tool({
  description:
    "Send a prompt to another opencode session's agent and wait for the response." +
    " The target session's agent will process the message and return its reply. Use for cross-session agent coordination.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("Target session ID"),
    text: tool.schema.string().describe("Prompt text to send"),
    agent: tool.schema.string().optional().describe("Switch the session to this agent before prompting (e.g. core, phone, build)"),
    model: tool.schema.string().optional().describe("Switch the session to this model as provider/model[#variant] before prompting"),
  },
  async execute(args, context: ToolContext) {
    return run(async () => {
      const client = sdk(args.host)
      await applyOverrides(client, args.id, args.agent, args.model)
      const header = buildCallerHeader(context, args.host)
      await client.session.prompt({ sessionID: args.id, text: `${header}\n${args.text}` })
      await client.session.wait({ sessionID: args.id }, { signal: context.abort })
      return lastAssistantText(client, args.id)
    })
  },
})

export const prompt_async = tool({
  description:
    "Send a prompt to another session without waiting for the response. Returns immediately." +
    " Reports whether the message was dispatched (session idle) or queued (session busy)." +
    " Use sessions_status to check when the session goes idle, then messages_read to get the result.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("Target session ID"),
    text: tool.schema.string().describe("Prompt text to send"),
    agent: tool.schema.string().optional().describe("Switch the session to this agent before prompting"),
    model: tool.schema.string().optional().describe("Switch the session to this model as provider/model[#variant] before prompting"),
    queue: tool.schema.boolean().optional().describe("Queue behind the current turn instead of steering it (default: steer)"),
  },
  async execute(args, context: ToolContext) {
    return run(async () => {
      const client = sdk(args.host)
      const active = await client.session.active()
      const wasBusy = !!active[args.id]

      await applyOverrides(client, args.id, args.agent, args.model)
      const header = buildCallerHeader(context, args.host)
      const inbox = await client.session.prompt({
        sessionID: args.id,
        text: `${header}\n${args.text}`,
        delivery: args.queue ? "queue" : "steer",
      })

      if (wasBusy) {
        return {
          status: "queued",
          session: args.id,
          host: args.host,
          inbox: inbox.id,
          delivery: inbox.delivery,
          note: "session was running — message admitted to its inbox and will process at the next step boundary",
        }
      }
      return { status: "dispatched", session: args.id, host: args.host, inbox: inbox.id }
    })
  },
})
