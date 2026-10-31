/**
 * TTS tools — direct HTTP to madcat-tts daemon.
 * GPU-quality speech synthesis via chatterbox (GPU clone), piper (CPU fast).
 * Cart/voice management + synthesis + local playback.
 *
 * Playback spawns the platform player (afplay / pw-play / paplay / aplay)
 * via src/lib/audio.ts, which tracks the process so completion is observed
 * rather than estimated.
 */

import { tool } from "../lib/tool"
import { execSync } from "child_process"
import { writeFileSync, unlinkSync, renameSync, utimesSync } from "fs"
import { tmpdir, homedir } from "os"
import { join } from "path"
import { ttsUrl } from "../lib/config.ts"
import { play, playerName } from "../lib/audio.ts"

/**
 * TTS echo gate.
 * While we play audio locally, we drop a flag file that the madcat-ear STT
 * capture daemon watches. The ear stops forwarding mic frames to the STT while
 * the flag exists, so the agent's own speech never loops back through the
 * studio mic and gets transcribed as an operator command.
 *
 * The flag is best-effort: if writing fails (e.g. a host without the ear),
 * playback proceeds normally. The ear has its own staleness guard (30s) so a
 * crash here never leaves it permanently deaf.
 */
const MUTE_FLAG =
  process.env.MADCAT_EAR_MUTE_FLAG ||
  join(homedir(), ".local/share/madcat/ear.muted")
// Extra silence held after playback for speaker ring-out / STT tail before we
// re-open the mic. Keeps the decay of the last word from leaking in.
const MUTE_TAIL_MS = Number(process.env.MADCAT_EAR_MUTE_TAIL_MS ?? "400")

function earMute(): void {
  try {
    writeFileSync(MUTE_FLAG, String(Date.now()))
  } catch {
    // Ear not present on this host, or dir missing — ignore.
  }
}

function earUnmute(): void {
  try {
    unlinkSync(MUTE_FLAG)
  } catch {
    // Already gone — fine.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Play audio locally, wrapped in the ear echo gate so the ear stops listening
 * while we speak. The player process is tracked, so in both modes the mute is
 * cleared when the clip actually ends (plus MUTE_TAIL_MS). Long clips refresh
 * the flag's mtime so the ear's 30s staleness guard never trips mid-playback.
 */
async function playAudio(filePath: string, wait: boolean): Promise<void> {
  earMute()
  let playback: Awaited<ReturnType<typeof play>>
  try {
    playback = await play(filePath, { wait })
  } catch (e) {
    earUnmute()
    throw e
  }

  const keepalive = setInterval(() => {
    try {
      const now = new Date()
      utimesSync(MUTE_FLAG, now, now)
    } catch {
      clearInterval(keepalive)
    }
  }, 10000)

  const finish = playback.exited.then(async () => {
    clearInterval(keepalive)
    await sleep(MUTE_TAIL_MS)
    earUnmute()
  })

  if (wait) await finish
  else void finish.catch(earUnmute)
}

const TTS_URL = ttsUrl()

async function ttsRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<{ data?: any; error?: string }> {
  const url = `${TTS_URL}${path}`
  const headers: Record<string, string> = {}
  let reqBody: string | undefined

  if (body !== undefined) {
    headers["Content-Type"] = "application/json"
    reqBody = JSON.stringify(body)
  }

  try {
    const res = await fetch(url, { method, headers, body: reqBody })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return { error: `HTTP ${res.status}: ${text || res.statusText}` }
    }
    const contentType = res.headers.get("Content-Type") || ""
    if (contentType.includes("application/json")) {
      return { data: await res.json() }
    }
    // Binary response (audio)
    const buf = await res.arrayBuffer()
    return { data: { buffer: Buffer.from(buf), headers: Object.fromEntries(res.headers.entries()) } }
  } catch (e: any) {
    return { error: `TTS request failed: ${e?.message || e}` }
  }
}

export const speak = tool({
  description:
    "Synthesize speech via madcat-tts (GPU). Plays locally via afplay (macOS) or pw-play (Linux). " +
    "Supports voice cloning (chatterbox), piper (fast CPU), and XTTS (remote). " +
    "voice param accepts: voice id (e.g. 'bt7274-pl'), cart tag (e.g. 'bt7274'), or omit for active.",
  args: {
    text: tool.schema.string().describe("Text to synthesize"),
    voice: tool.schema.string().optional().describe("Voice id or cart tag (default: active voice)"),
    language: tool.schema.string().optional().describe("Language override (e.g. 'en', 'pl')"),
    format: tool.schema.string().optional().describe("Response format: wav, mp3, flac (default: wav)"),
    wait: tool.schema.boolean().optional().describe("Wait for playback to finish (default: false)"),
  },
  async execute(args) {
    const payload: Record<string, any> = {
      input: args.text,
      response_format: args.format || "wav",
    }
    if (args.voice) payload.voice = args.voice
    if (args.language) payload.language = args.language

    const { data, error } = await ttsRequest("POST", "/v1/audio/speech", payload)
    if (error) return `TTS error: ${error}`

    // Write audio to temp file, normalize loudness, and play
    const ext = args.format || "wav"
    const rawPath = join(tmpdir(), `madcat-tts-raw-${Date.now()}.${ext}`)
    const tmpPath = join(tmpdir(), `madcat-tts-${Date.now()}.${ext}`)
    try {
      writeFileSync(rawPath, data.buffer)
      const headers = data.headers || {}
      const cart = headers["x-madcat-cart"] || "?"
      const voice = headers["x-madcat-voice"] || "?"
      const engine = headers["x-madcat-engine"] || "?"
      const duration = headers["x-madcat-duration-sec"] || "?"
      const backend = playerName() ?? "none"

      // Loudness normalize (EBU R128 -16 LUFS) so all voices play at same volume
      try {
        execSync(`ffmpeg -y -i "${rawPath}" -af loudnorm=I=-16:TP=-1.5:LRA=11 "${tmpPath}" 2>/dev/null`, { stdio: "ignore" })
        unlinkSync(rawPath)
      } catch {
        // ffmpeg failed — fall back to raw file
        renameSync(rawPath, tmpPath)
      }

      // Play audio locally via the platform player
      await playAudio(tmpPath, args.wait ?? false)

      return JSON.stringify(
        { status: "playing", cart, voice, engine, duration_sec: duration, backend, file: tmpPath },
        null,
        2
      )
    } catch (e: any) {
      return `Playback error: ${e?.message || e}`
    }
  },
})

export const list = tool({
  description:
    "List all TTS carts and voices from madcat-tts daemon. Shows cart tags, voices per cart, engines, languages.",
  args: {},
  async execute() {
    const { data, error } = await ttsRequest("GET", "/carts")
    if (error) return `Error: ${error}`
    return JSON.stringify(data, null, 2)
  },
})

export const active = tool({
  description: "Get the currently active TTS cart and voice.",
  args: {},
  async execute() {
    const { data, error } = await ttsRequest("GET", "/carts/active")
    if (error) return `Error: ${error}`
    return JSON.stringify(data, null, 2)
  },
})

export const switch_voice = tool({
  description:
    "Switch active TTS voice. Accepts a voice id (e.g. 'bt7274-en') or cart tag (e.g. 'bt7274' → uses its default_voice).",
  args: {
    id: tool.schema.string().describe("Voice id or cart tag to activate"),
  },
  async execute(args) {
    const { data, error } = await ttsRequest("POST", "/carts/active", { id: args.id })
    if (error) return `Error: ${error}`
    return JSON.stringify(data, null, 2)
  },
})

export const health = tool({
  description: "Check madcat-tts daemon health — engine availability and active cart.",
  args: {},
  async execute() {
    const { data, error } = await ttsRequest("GET", "/health")
    if (error) return `Error: ${error}`
    return JSON.stringify(data, null, 2)
  },
})
