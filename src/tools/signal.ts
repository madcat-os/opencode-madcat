/**
 * Signal tools — send messages and voice notes to the operator via Signal.
 *
 * signal-cli host, account, operator, and TTS URL are all read from
 * ~/.config/madcat/config.toml [signal] and [tts] sections.
 * Attachments are SCP'd to the signal host when running remotely.
 */

import { tool } from "../lib/tool"
import { writeFileSync, unlinkSync } from "fs"
import { tmpdir, hostname } from "os"
import { join } from "path"
import { ttsUrl, signalApiUrl, signalHost, signalAccount, signalOperator } from "../lib/config.ts"
import { execFileSync } from "child_process"

const SIGNAL_API = signalApiUrl()
const SIGNAL_HOST = signalHost()
const ACCOUNT = signalAccount()
const OPERATOR = signalOperator()
const TTS_URL = ttsUrl()

/** True when this process is running on the same host as signal-cli. */
const IS_LOCAL = (() => {
  try {
    const url = new URL(SIGNAL_API)
    return /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(url.hostname)
  } catch {
    return false
  }
})()

let rpcId = 0

/** Send a JSON-RPC request to signal-cli daemon. */
async function signalRpc(
  method: string,
  params: Record<string, any>,
): Promise<any> {
  const body = {
    jsonrpc: "2.0",
    method,
    id: String(++rpcId),
    params: { ...params },
  }

  const res = await fetch(SIGNAL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Signal API HTTP ${res.status}: ${text}`)
  }

  const json = (await res.json()) as any
  if (json.error) {
    throw new Error(`Signal RPC error: ${JSON.stringify(json.error)}`)
  }
  return json.result
}

/**
 * Synthesize speech via madcat-tts, save to signal host's /tmp.
 * If running on the signal host, writes directly. Otherwise SCP's.
 */
async function synthesizeForSignal(
  text: string,
  voice?: string,
  language?: string,
): Promise<string> {
  const payload: Record<string, any> = {
    input: text,
    response_format: "wav",
  }
  if (voice) payload.voice = voice
  if (language) payload.language = language

  const res = await fetch(`${TTS_URL}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`TTS synthesis failed: HTTP ${res.status} ${body}`)
  }

  const buf = Buffer.from(await res.arrayBuffer())

  // Signal voice notes must be AAC (m4a). A raw WAV renders as a plain file
  // attachment with no inline play button, even with voiceNote:true. Transcode
  // WAV -> AAC via ffmpeg before sending.
  const stamp = Date.now()
  const wavLocal = join(tmpdir(), `signal-voice-${stamp}.wav`)
  const m4aLocal = join(tmpdir(), `signal-voice-${stamp}.m4a`)
  writeFileSync(wavLocal, buf)
  try {
    execFileSync(
      "ffmpeg",
      ["-y", "-i", wavLocal, "-c:a", "aac", "-b:a", "64k", m4aLocal],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
    )
  } catch (e: any) {
    throw new Error(`ffmpeg WAV->AAC transcode failed: ${e?.message ?? e}`)
  } finally {
    try { unlinkSync(wavLocal) } catch {}
  }

  const remotePath = `/tmp/signal-voice-${stamp}.m4a`

  if (IS_LOCAL) {
    if (m4aLocal !== remotePath) {
      execFileSync("cp", [m4aLocal, remotePath], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      })
      try { unlinkSync(m4aLocal) } catch {}
    }
  } else {
    try {
      execFileSync("scp", [m4aLocal, `${SIGNAL_HOST}:${remotePath}`], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      })
    } finally {
      try { unlinkSync(m4aLocal) } catch {}
    }
  }

  return remotePath
}

/**
 * Ensure a file is on the signal host. If local, SCP it.
 * signal-cli needs local file access for attachments.
 */
function toSignalHostPath(localPath: string): string {
  if (IS_LOCAL) return localPath
  const name = localPath.split("/").pop() || "file"
  const remotePath = `/tmp/signal-${Date.now()}-${name}`
  execFileSync("scp", [localPath, `${SIGNAL_HOST}:${remotePath}`], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  })
  return remotePath
}

export const send = tool({
  description:
    "Send a Signal message to the operator. Use this to reach the user when they're away from the terminal — " +
    "alerts, status updates, task completion notices, or quick questions. " +
    "Supports optional file attachments (images, PDFs, etc.).",
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
      .describe("Override recipient phone number (default: operator)"),
  },
  async execute(args) {
    const to = args.recipient || OPERATOR
    const params: Record<string, any> = {
      recipient: [to],
      message: args.message,
    }

    if (args.attachment) {
      const remotePath = toSignalHostPath(args.attachment)
      params.attachment = [remotePath]
    }

    const result = await signalRpc("send", params)

    return JSON.stringify({
      success: true,
      timestamp: result.timestamp,
      recipient: to,
      message: args.message,
      attachment: args.attachment || null,
    })
  },
})

export const voice = tool({
  description:
    "Send a voice note to the operator via Signal. Synthesizes text via madcat-tts (GPU), " +
    "then sends as an inline voice note that plays directly in Signal. " +
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
      .describe("Override recipient phone number (default: operator)"),
  },
  async execute(args) {
    const to = args.recipient || OPERATOR

    const remotePath = await synthesizeForSignal(args.text, args.voice_id, args.language)

    const result = await signalRpc("send", {
      recipient: [to],
      message: "",
      attachment: [remotePath],
      voiceNote: true,
    })

    return JSON.stringify({
      success: true,
      timestamp: result.timestamp,
      recipient: to,
      text: args.text,
      voice: args.voice_id || "active",
    })
  },
})
