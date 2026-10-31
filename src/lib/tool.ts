/**
 * Local tool() helper — v1-compatible authoring surface over the v2 plugin API.
 *
 * The v2 plugin API registers tools via `ctx.tool.transform(editor => editor.add({...}))`
 * with a JSON-Schema / StandardSchema `input` and a `{ content }` result. Rather than
 * rewrite all ~35 tool modules, this helper preserves the exact v1 shape:
 *
 *   tool({ description, args: ZodRawShape, execute(args, ctx) => string | {...} })
 *
 * `index.ts` adapts each definition to a v2 `editor.add(...)` call: it wraps `args`
 * in a Zod object (which is a StandardSchemaV1, accepted directly as v2 `input`) and
 * normalizes the return value to a v2 `{ content }` result.
 *
 * `tool.schema` re-exports Zod so `tool.schema.string()` etc. keep working verbatim.
 */

import { z } from "zod"

/** Tool execution context passed to every tool's execute() — v1-compatible surface. */
export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  /** Current project directory (injected from ctx.location at plugin setup). */
  directory: string
  /** Project worktree root (injected from ctx.location at plugin setup). */
  worktree: string
  /** Abort signal for the running tool call (v2 ToolContext.signal). */
  abort: AbortSignal
}

export type ToolAttachment = {
  type: "file"
  mime: string
  url: string
  filename?: string
}

/** v1-compatible tool result: a bare string or a structured object. */
export type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: { [key: string]: any }
      attachments?: ToolAttachment[]
    }

export type ToolDefinition<Args extends z.ZodRawShape = z.ZodRawShape> = {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}): ToolDefinition<Args> {
  return input
}

export namespace tool {
  export const schema = z
}
