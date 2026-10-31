/**
 * cart — persona cart management.
 *
 * Reads/writes ~/.local/share/madcat/tts-state.toml for active cart,
 * reads cart definitions from ~/.config/madcat/carts/*.toml.
 */

import { tool } from "../lib/tool"
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parse, stringify } from "smol-toml"
import { ttsUrl } from "../lib/config.ts"

const CARTS_DIR = join(homedir(), ".config", "madcat", "carts")
const TTS_STATE = join(homedir(), ".local", "share", "madcat", "tts-state.toml")

/**
 * Tell the running madcat-tts daemon to switch its active voice.
 * cart_load writes tts-state.toml, but the daemon holds its own in-memory
 * active voice — without this call, persona and voice desync (e.g. BT-7274
 * cart speaking through AIDA's voice). Best-effort: failure to reach the
 * daemon does not fail the cart switch.
 */
async function syncDaemonVoice(voiceId: string): Promise<{ synced: boolean; error?: string }> {
  try {
    const res = await fetch(`${ttsUrl()}/carts/active`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: voiceId }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return { synced: false, error: `HTTP ${res.status}: ${text || res.statusText}` }
    }
    return { synced: true }
  } catch (e: any) {
    return { synced: false, error: `TTS daemon unreachable: ${e?.message || e}` }
  }
}

function readState(): Record<string, any> {
  try {
    return parse(readFileSync(TTS_STATE, "utf-8"))
  } catch {
    return {}
  }
}

function writeState(state: Record<string, any>): void {
  writeFileSync(TTS_STATE, stringify(state), "utf-8")
}

function loadCart(tag: string): Record<string, any> | null {
  const path = join(CARTS_DIR, `${tag}.toml`)
  if (!existsSync(path)) return null
  try {
    return parse(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

export const info = tool({
  description:
    "Get the active persona cart — tag, name, tagline, prompt, default voice, and all voices.",
  args: {},
  async execute() {
    const state = readState()
    const tag = state.active_cart
    if (!tag) return JSON.stringify({ error: "No active cart in tts-state.toml" })

    const cart = loadCart(tag)
    if (!cart) return JSON.stringify({ error: `Cart file not found: ${tag}.toml` })

    return JSON.stringify(
      {
        tag,
        active_voice: state.active_voice ?? null,
        persona: cart.persona ?? {},
        default_voice: cart.persona?.default_voice ?? null,
        voices: cart.voices ?? [],
      },
      null,
      2,
    )
  },
})

export const list = tool({
  description: "List all available persona carts — tag, name, tagline, default voice.",
  args: {},
  async execute() {
    const state = readState()
    const activeTag = state.active_cart ?? null

    let files: string[]
    try {
      files = readdirSync(CARTS_DIR).filter((f) => f.endsWith(".toml")).sort()
    } catch {
      return JSON.stringify({ error: `Cannot read carts dir: ${CARTS_DIR}` })
    }

    const carts = files.map((f) => {
      const tag = f.replace(/\.toml$/, "")
      const cart = loadCart(tag)
      const persona = cart?.persona ?? {}
      return {
        tag,
        name: persona.name ?? tag,
        tagline: persona.tagline ?? null,
        default_voice: persona.default_voice ?? null,
        active: tag === activeTag,
      }
    })

    return JSON.stringify({ active: activeTag, carts }, null, 2)
  },
})

export const load = tool({
  description:
    "Switch the active persona cart. Updates tts-state.toml and sets the default voice. " +
    "Takes effect on the next LLM turn (persona hook reads fresh).",
  args: {
    tag: tool.schema.string().describe("Cart tag to activate (e.g. 'bt7274', 'samantha')"),
  },
  async execute(args) {
    const cart = loadCart(args.tag)
    if (!cart) {
      let available: string[]
      try {
        available = readdirSync(CARTS_DIR)
          .filter((f) => f.endsWith(".toml"))
          .map((f) => f.replace(/\.toml$/, ""))
      } catch {
        available = []
      }
      return JSON.stringify({
        error: `Cart '${args.tag}' not found`,
        available,
      })
    }

    const defaultVoice = cart.persona?.default_voice ?? `${args.tag}-en`
    const state = readState()
    state.active_cart = args.tag
    state.active_voice = defaultVoice
    writeState(state)

    // Propagate the voice to the running TTS daemon so persona + voice never
    // desync. Best-effort — the cart switch itself has already succeeded.
    const daemon = await syncDaemonVoice(defaultVoice)

    return JSON.stringify(
      {
        switched: true,
        tag: args.tag,
        name: cart.persona?.name ?? args.tag,
        active_voice: defaultVoice,
        voice_synced: daemon.synced,
        ...(daemon.error ? { voice_sync_error: daemon.error } : {}),
      },
      null,
      2,
    )
  },
})
