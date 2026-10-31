/**
 * WhatsApp tools — send messages and voice notes to the operator via WhatsApp.
 *
 * Uses the whatsapp-bridge HTTP API (Bun.serve + Baileys) rather than
 * signal-cli's JSON-RPC. The bridge accepts simple REST calls and forwards
 * to WhatsApp via the linked device session.
 *
 * Bridge URL is read from env WA_BRIDGE_URL, config.toml [whatsapp],
 * or defaults to http://localhost:7591.
 */

import { tool } from "../lib/tool"
import { readFileSync } from "fs"
import { whatsappBridgeUrl, whatsappOperator, ttsUrl } from "../lib/config.ts"

const BRIDGE_URL = whatsappBridgeUrl()
const OPERATOR = whatsappOperator()
const TTS_URL = ttsUrl()

/** Derive the bridge channel from the agent name. Double agent → "double", everything else → "assistant". */
function channelForAgent(agent?: string): "double" | "assistant" {
  return agent === "double" ? "double" : "assistant"
}

/**
 * POST to the whatsapp-bridge /send endpoint.
 *
 * The bridge exposes a single bare `POST /send` route (Bun.serve + Baileys) —
 * it does not consume a channel path segment. The `channel` arg is retained for
 * call-site compatibility but is passed in the body for the bridge to route on
 * if/when it supports multiplexing; the endpoint itself stays `/send`.
 */
async function bridgeSend(body: {
  to: string
  message?: string
  attachment?: string
  location?: { lat: number; lon: number; name?: string; address?: string }
  /** Group replies: id of the message to quote (from the <group message_id="…"> attribute). */
  quote_id?: string
  /** Group replies: numbers/JIDs to @mention. The bridge resolves them to the group's native ids. */
  mentions?: string[]
}, channel: "double" | "assistant" = "assistant"): Promise<{ success: boolean; timestamp?: number; error?: string }> {
  const res = await fetch(`${BRIDGE_URL}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, channel }),
  })

  const json = (await res.json()) as any
  if (!res.ok || !json.success) {
    throw new Error(json.error ?? `Bridge HTTP ${res.status}`)
  }
  return json
}

/**
 * POST to the whatsapp-bridge /presence endpoint.
 * presence: 'composing' (typing), 'recording' (recording audio), or 'paused' (idle).
 * Best-effort (never throws / never blocks message flow).
 */
export async function bridgePresence(
  to: string,
  presence: "composing" | "recording" | "paused" = "composing",
): Promise<void> {
  try {
    await fetch(`${BRIDGE_URL}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, presence }),
    })
  } catch {
    // Non-blocking best-effort
  }
}

/** Read a local file and return a data URI (base64). */
function fileToDataUri(path: string): string {
  const buf = readFileSync(path)
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    opus: "audio/opus",
    mp4: "video/mp4",
  }
  const mime = mimeMap[ext] || "application/octet-stream"
  return `data:${mime};base64,${buf.toString("base64")}`
}

export const send = tool({
  description:
    "Send a WhatsApp message to the operator. Use this to reach the user via WhatsApp — " +
    "alerts, status updates, task completion notices, or quick questions. " +
    "Supports optional file attachments (images, PDFs, etc.). " +
    "To reply in a WhatsApp GROUP, set recipient to the group JID (…@g.us) from the incoming " +
    "<group jid=\"…\"> tag, quote_id to its message_id so the reply threads under the original, " +
    "and mentions to the sender's number to @tag them. Only allowlisted groups accept messages.",
  args: {
    message: tool.schema
      .string()
      .describe("Message text to send"),
    attachment: tool.schema
      .string()
      .optional()
      .describe("File path to attach (image, PDF, etc.)"),
    recipient: tool.schema
      .string()
      .optional()
      .describe("Override recipient: phone number (default: operator, no + prefix) or a group JID like 120363…@g.us."),
    quote_id: tool.schema
      .string()
      .optional()
      .describe("Group replies: message_id of the message to quote (from the incoming <group> tag)."),
    mentions: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Group replies: phone numbers (e.g. +48501000001) to @mention. Written as @number in the text or auto-prepended."),
  },
  async execute(args, ctx) {
    const to = args.recipient || OPERATOR
    const channel = channelForAgent(ctx?.agent)

    // Ensure typing indicator is asserted
    await bridgePresence(to, "composing")

    const body: {
      to: string
      message: string
      attachment?: string
      quote_id?: string
      mentions?: string[]
    } = {
      to,
      message: args.message,
    }

    if (args.attachment) {
      body.attachment = fileToDataUri(args.attachment)
    }
    if (args.quote_id) body.quote_id = args.quote_id
    if (args.mentions?.length) body.mentions = args.mentions

    const result = await bridgeSend(body, channel)

    return JSON.stringify({
      success: true,
      timestamp: result.timestamp,
      recipient: to,
      message: args.message,
      attachment: args.attachment || null,
      quote_id: args.quote_id || null,
      mentions: args.mentions || null,
    })
  },
})

export const voice = tool({
  description:
    "Send a voice note to the operator via WhatsApp. Synthesizes text via madcat-tts (GPU), " +
    "then sends as an audio message that plays directly in WhatsApp. " +
    "Use for spoken alerts, summaries, or when a voice message feels more natural than text.",
  args: {
    text: tool.schema
      .string()
      .describe("Text to synthesize and send as voice note"),
    voice_id: tool.schema
      .string()
      .optional()
      .describe("TTS voice id or cart tag (default: active voice)"),
    language: tool.schema
      .string()
      .optional()
      .describe("Language override (e.g. 'en', 'pl')"),
    recipient: tool.schema
      .string()
      .optional()
      .describe("Override recipient phone number (default: operator). No + prefix."),
  },
  async execute(args, ctx) {
    const to = args.recipient || OPERATOR
    const channel = channelForAgent(ctx?.agent)

    // Notify bridge to switch indicator to "recording audio..." in WhatsApp
    await bridgePresence(to, "recording")

    // Synthesize speech via madcat-tts
    const payload: Record<string, any> = {
      input: args.text,
      response_format: "wav",
    }
    if (args.voice_id) payload.voice = args.voice_id
    if (args.language) payload.language = args.language

    const ttsRes = await fetch(`${TTS_URL}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })

    if (!ttsRes.ok) {
      const body = await ttsRes.text().catch(() => "")
      throw new Error(`TTS synthesis failed: HTTP ${ttsRes.status} ${body}`)
    }

    const buf = Buffer.from(await ttsRes.arrayBuffer())
    const dataUri = `data:audio/wav;base64,${buf.toString("base64")}`

    const result = await bridgeSend({
      to,
      attachment: dataUri,
    }, channel)

    return JSON.stringify({
      success: true,
      timestamp: result.timestamp,
      recipient: to,
      text: args.text,
      voice: args.voice_id || "active",
    })
  },
})

export const send_location = tool({
  description:
    "Send a WhatsApp location pin (map marker) to the operator. " +
    "Drops a native WhatsApp location that opens in Maps.",
  args: {
    lat: tool.schema
      .number()
      .describe("Latitude of the location pin"),
    lon: tool.schema
      .number()
      .describe("Longitude of the location pin"),
    name: tool.schema
      .string()
      .optional()
      .describe("Optional place name shown on the pin"),
    address: tool.schema
      .string()
      .optional()
      .describe("Optional street address shown on the pin"),
    recipient: tool.schema
      .string()
      .optional()
      .describe("Override recipient phone number (default: operator). No + prefix."),
  },
  async execute(args, ctx) {
    const to = args.recipient || OPERATOR
    const channel = channelForAgent(ctx?.agent)

    const location: { lat: number; lon: number; name?: string; address?: string } = {
      lat: args.lat,
      lon: args.lon,
    }
    if (args.name) location.name = args.name
    if (args.address) location.address = args.address

    const result = await bridgeSend({ to, location }, channel)

    return JSON.stringify({
      success: true,
      timestamp: result.timestamp,
      recipient: to,
      location,
    })
  },
})

export const presence = tool({
  description:
    "Set WhatsApp presence status for a recipient. " +
    "Use 'composing' for typing indicator, 'recording' for audio recording indicator, or 'paused' to clear.",
  args: {
    presence: tool.schema
      .enum(["composing", "recording", "paused"])
      .describe("Presence state to broadcast: 'composing' (typing), 'recording' (recording audio), or 'paused' (idle)"),
    recipient: tool.schema
      .string()
      .optional()
      .describe("Recipient phone number (default: operator). No + prefix."),
  },
  async execute(args) {
    const to = args.recipient || OPERATOR
    await bridgePresence(to, args.presence)
    return JSON.stringify({ success: true, to, presence: args.presence })
  },
})
