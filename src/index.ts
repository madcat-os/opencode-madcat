/**
 * madcat-plugin — opencode plugin for Nahel Argama fleet ops.
 *
 * V2 plugin API (@opencode/plugin). Ported from the V1 entrypoint:
 *   - Plugin.define({ id, setup(ctx) }) replaces the exported plugin function.
 *   - Tools register through ctx.tool.transform(editor => editor.add(...)).
 *   - Persona + doctrine inject via ctx.session.hook("context", ...).
 *   - Idle notices run off ctx.event.subscribe().
 *   - Mesh-facing tools talk to remote serves via @opencode/client (src/lib/sdk.ts).
 *
 * Tool modules keep the V1 authoring shape via the local `tool()` shim
 * (src/lib/tool.ts); this file adapts each definition to the V2 editor.
 */

import { Plugin } from "@opencode/plugin"
import { z } from "zod"
import type { ToolDefinition, ToolContext } from "./lib/tool"
import { doctrine } from "./hooks/doctrine"
import { idle } from "./hooks/idle"
import { persona } from "./hooks/persona"
import { allDoctrines } from "./lib/doctrines"
import { mirrorDoctrines } from "./lib/mirror"
import { initNative } from "./lib/native"

// ── Tool modules (pure TS — always available) ───────────────
import * as auth from "./tools/auth"
import * as control from "./tools/control"
import * as infra from "./tools/infra"
import * as json from "./tools/json"
import * as messages from "./tools/messages"
import * as pty from "./tools/pty"
import * as server from "./tools/server"
import * as sessions from "./tools/sessions"
import * as smoketest from "./tools/smoketest"
import * as tools from "./tools/tools"
import { bindToolLister } from "./tools/tools"
import * as whoami from "./tools/whoami"

import * as prime from "./tools/prime"
import * as image from "./tools/image"
import * as memory from "./tools/memory"

/** A V1-shaped tool definition carries `description` + `execute` (+ `args`). */
function isToolDef(v: unknown): v is ToolDefinition {
  return !!v && typeof v === "object" && "execute" in v && "description" in v
}

/**
 * Namespace a module's tool exports: { read } → { json_read }, returning
 * V1-shaped definitions keyed by their effective V2 tool name.
 */
function ns(prefix: string, mod: Record<string, unknown>): Record<string, ToolDefinition> {
  const out: Record<string, ToolDefinition> = {}
  for (const [k, v] of Object.entries(mod)) {
    if (isToolDef(v)) out[`${prefix}_${k}`] = v
  }
  return out
}

/** Normalize a V1 tool result (string | {output,...}) to a V2 `{ content }`. */
function toContent(result: unknown): { content: string; metadata?: Record<string, any> } {
  if (typeof result === "string") return { content: result }
  if (result && typeof result === "object") {
    const r = result as { output?: string; metadata?: Record<string, any> }
    return { content: r.output ?? "", metadata: r.metadata }
  }
  return { content: String(result ?? "") }
}

export default Plugin.define({
  id: "madcat",
  async setup(ctx) {
    const idleHandler = idle(ctx)
    const personaHandler = persona(ctx)
    const doctrineHandler = doctrine()

    // Warm EEMS (resolves the signed-in principal).
    await initNative()

    // One-shot fs → EEMS mirror at plugin init. Filesystem stays canonical;
    // this populates `doctrine.<slug>` subjects in the principal's EEMS for
    // read-only access by other consumers. Skips with a reason when no
    // principal resolves. Idempotent. Runs in the background so a slow
    // embedding endpoint never delays plugin load.
    void mirrorDoctrines(allDoctrines())
      .then((r) => {
        if (r.skipped_reason) console.warn(`[eems] doctrine mirror skipped: ${r.skipped_reason}`)
      })
      .catch(() => {
        /* never block plugin load */
      })

    // ── Register all tools ────────────────────────────────────
    const defs: Record<string, ToolDefinition> = {
      ...ns("image", image),
      ...ns("memory", memory),
      ...ns("auth", auth),
      ...ns("control", control),
      ...ns("infra", infra),
      ...ns("json", json),
      ...ns("messages", messages),
      ...ns("prime", prime),
      ...ns("pty", pty),
      ...ns("server", server),
      ...ns("sessions", sessions),
      ...ns("smoketest", smoketest),
      ...ns("tools", tools),
      ...ns("whoami", whoami),
    }

    const directory = ctx.location.directory
    const worktreeRoot = ctx.location.project?.directory ?? directory

    // tools_ids / tools_schemas read the live registry of this host.
    bindToolLister(() => ctx.tool.list())

    await ctx.tool.transform((editor) => {
      for (const [name, def] of Object.entries(defs)) {
        editor.add({
          name,
          description: def.description,
          // V1 `args` is a ZodRawShape; a Zod object is a StandardSchemaV1,
          // accepted directly as the V2 `input` schema.
          input: z.object(def.args ?? {}),
          async execute(input, context) {
            // Reconstruct the V1 ToolContext from the V2 ToolContext, injecting
            // directory/worktree (which live on ctx.location in V2).
            const v1ctx: ToolContext = {
              sessionID: context.sessionID as unknown as string,
              messageID: context.messageID as unknown as string,
              agent: context.agent as unknown as string,
              directory,
              worktree: worktreeRoot,
              abort: context.signal,
            }
            const result = await def.execute(input as any, v1ctx)
            return toContent(result)
          },
        })
      }
    })

    // ── Session context hook: persona + doctrine injection ─────
    await ctx.session.hook("context", async (event) => {
      await personaHandler(event as any)
      await doctrineHandler(event as any)
    })

    // ── Event subscriptions: idle notices ──────────────────────
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const e = event as { type: string; data?: any }
          if (e.type === "session.idle") await idleHandler(e)
        }
      } catch {
        /* subscription aborted on unload — expected */
      }
    })()

    return () => controller.abort()
  },
})
