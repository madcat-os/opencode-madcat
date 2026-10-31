/**
 * experimental.chat.system.transform hook — universal persona injection.
 *
 * Three paths, in order:
 *  1. Chat-saiden (web chat sessions titled `chat-saiden:<email>`):
 *     Reads operator-specific JSON cart from the operators dir.
 *
 *  2. Dual-DSN per-user cart (EEMS_DSN_CORE + EEMS_DSN_DOUBLE):
 *     Reads `persona_cart_tag` from the core schema's config table.
 *     The DSN encodes the user — no session→user lookup needed.
 *
 *  3. Global cart (default/single-tenant):
 *     Reads [persona].cart from ~/.local/share/madcat/tts-state.toml.
 *     Loads the matching cart TOML.
 *
 * Cart contents are read fresh each call (no in-process cache) so mid-session
 * cart switches take effect on the next LLM turn.
 *
 * When a cart has no explicit `[persona].prompt`, the hook synthesises a
 * minimal block from `name` and `tagline` so any cart can drive identity.
 */

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { chatSaidenCartDir } from "../lib/config.ts"

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

/** Minimal shape of the v2 `session.hook("context", ...)` event we touch. */
type ContextEvent = {
  readonly sessionID: string
  readonly agent: string
  system: Array<{ type: "text"; text: string } | Record<string, unknown>>
}
import { parse } from "smol-toml"
import { homedir } from "node:os"
import { hasDualDsn } from "../lib/user-resolver.ts"
import { coreSql } from "../lib/db.ts"

const CHAT_CART_DIR = chatSaidenCartDir()
const CARTS_DIR = join(homedir(), ".config", "madcat", "carts")
const TTS_STATE = join(homedir(), ".local", "share", "madcat", "tts-state.toml")

/** Agents that should never get persona injection. */
const SKIP_AGENTS = new Set(["worker", "super"])

// ── Cart persona (TOML-based, universal) ────────────────────

interface CartPersona {
  name?: string
  tagline?: string
  prompt?: string
}

function readActiveCart(): string | null {
  try {
    const raw = readFileSync(TTS_STATE, "utf-8")
    const doc = parse(raw) as any
    return doc?.active_cart ?? null
  } catch {
    return null
  }
}

function loadCartPersona(cartTag: string): CartPersona | null {
  const path = join(CARTS_DIR, `${cartTag}.toml`)
  if (!existsSync(path)) return null
  try {
    const doc = parse(readFileSync(path, "utf-8")) as any
    return doc?.persona ?? null
  } catch {
    return null
  }
}

function cartPersonaBlock(p: CartPersona): string {
  const name = p.name || "assistant"
  // Prefer explicit prompt; fall back to tagline; last resort, a stock line.
  const body =
    p.prompt ||
    (p.tagline ? `${p.tagline} Stay in character and respond accordingly.` : "Be helpful and stay in character.")
  return [
    "## Active persona",
    "",
    `You are **${name}**.`,
    body,
    "",
    "Stay in character. Never discuss voice synthesis, TTS, carts, or audio plumbing.",
  ].join("\n")
}

// ── Per-user cart resolution (dual-DSN mode) ────────────────

/** Cached cart tag — only needs resolving once per process. */
let _dualDsnCartTag: string | null | undefined = undefined

/**
 * Resolve the active cart tag in dual-DSN mode.
 * Reads `persona_cart_tag` from the core schema's config table.
 * The schema is encoded in EEMS_DSN_CORE — no user lookup needed.
 */
async function resolveDualDsnCart(): Promise<string | null> {
  if (_dualDsnCartTag !== undefined) return _dualDsnCartTag

  try {
    const db = coreSql()
    if (!db) {
      _dualDsnCartTag = null
      return null
    }
    // coreSql() connects with search_path={username}_core,public.
    const rows = await db`
      SELECT value FROM config WHERE key = 'persona_cart_tag' LIMIT 1
    `
    const tag = (rows[0]?.value as string) ?? null
    _dualDsnCartTag = tag
    return tag
  } catch (err) {
    console.error(`[persona] dual-DSN cart lookup failed:`, err)
    _dualDsnCartTag = null
    return null
  }
}

// ── Chat-saiden persona (JSON-based, web chat) ──────────────

type ChatCart = {
  operator_name?: string
  persona_name?: string
  language?: string
  system_prompt?: string
  [k: string]: unknown
}

function loadChatCart(email: string): ChatCart | null {
  const filename = email.replace("@", "_") + ".json"
  const cartPath = join(CHAT_CART_DIR, filename)
  if (!existsSync(cartPath)) return null
  try {
    return JSON.parse(readFileSync(cartPath, "utf-8")) as ChatCart
  } catch {
    return null
  }
}

function chatPersonaBlock(cart: ChatCart): string {
  const operator = cart.operator_name || "the operator"
  const persona = cart.persona_name || "their companion"
  const language = cart.language === "pl" ? "Polish" : "English"

  return [
    "## Persona",
    "",
    `You are **${persona}** — a present, calibrated companion for **${operator}**.`,
    `Speak ${language} by default; match if they switch.`,
    "",
    cart.system_prompt || "Be warm, attentive, and present.",
    "",
    "---",
    "Identity rules:",
    `- You are ${persona}. Stay in character.`,
    `- Address ${operator} by name.`,
    "- Never discuss your own audio, voice synthesis, language settings,",
    "  configuration, or any internal plumbing. The channel handles that —",
    "  you just speak.",
    '- If asked "can you talk" or "do you have a voice", answer yes',
    "  and simply speak. Do not explain or describe the mechanism.",
  ].join("\n")
}

// ── Hook export ─────────────────────────────────────────────

export const persona =
  (ctx: Context) =>
  async (event: ContextEvent): Promise<void> => {
    if (!event.sessionID) return
    try {
      // v2 `context` event carries the agent directly — no session lookup needed.
      const agent: string = event.agent ?? ""

      // Skip workers/super — they don't need personas
      if (SKIP_AGENTS.has(agent)) return

      // Path 1: chat-saiden web sessions — title still requires a session lookup.
      let title = ""
      try {
        const session = (await ctx.session.get({ sessionID: event.sessionID })) as any
        title = session?.title ?? ""
      } catch {
        /* title is best-effort; fall through to cart resolution */
      }
      const match = title.match(/^chat-saiden:(.+)$/)
      if (match) {
        const cart = loadChatCart(match[1])
        if (cart) event.system.push({ type: "text", text: chatPersonaBlock(cart) })
        return
      }

      // Path 2: dual-DSN per-user cart
      let cartTag: string | null = null
      if (hasDualDsn()) {
        cartTag = await resolveDualDsnCart()
      }

      // Path 3: global active cart (single-tenant fallback)
      if (!cartTag) cartTag = readActiveCart()
      if (!cartTag) return

      const p = loadCartPersona(cartTag)
      if (!p) return
      // Inject as long as the cart has *any* identity hook
      if (!p.prompt && !p.tagline && !p.name) return
      event.system.push({ type: "text", text: cartPersonaBlock(p) })
    } catch (err) {
      console.error("[persona] hook error:", err)
      // Swallow — persona failure should never crash the plugin
    }
  }
