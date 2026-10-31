/**
 * Audio tools — CADENCE's arsenal.
 * File inspection, conversion, trimming, splitting, mixing, effects.
 * All tools use ffmpeg/ffprobe — no Python deps, no librosa.
 */

import { tool } from "../lib/tool"
import { execSync } from "child_process"
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join, extname, basename, dirname } from "path"

// ── Helpers ──────────────────────────────────────────────────

function run(cmd: string, timeout = 30_000): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.()?.trim() || ""
    throw new Error(stderr || e?.message || "Command failed")
  }
}

function assertFile(path: string): void {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`)
}

function tmpAudio(ext: string): string {
  return join(tmpdir(), `madcat-audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
}

// ── 1. Probe ─────────────────────────────────────────────────

export const probe = tool({
  description:
    "Inspect audio file metadata — duration, sample rate, channels, codec, bit rate, format. " +
    "Uses ffprobe. Returns structured JSON.",
  args: {
    path: tool.schema.string().describe("Path to audio file"),
  },
  async execute(args) {
    assertFile(args.path)

    // Get stream info
    const streamJson = run(
      `ffprobe -v quiet -print_format json -show_streams -show_format "${args.path}"`
    )
    const info = JSON.parse(streamJson)
    const stream = info.streams?.find((s: any) => s.codec_type === "audio") || info.streams?.[0] || {}
    const format = info.format || {}

    return JSON.stringify(
      {
        file: args.path,
        duration_sec: parseFloat(format.duration || stream.duration || "0"),
        sample_rate: parseInt(stream.sample_rate || "0", 10),
        channels: stream.channels || 0,
        channel_layout: stream.channel_layout || null,
        codec: stream.codec_name || null,
        codec_long: stream.codec_long_name || null,
        bit_rate: parseInt(format.bit_rate || stream.bit_rate || "0", 10),
        format: format.format_name || null,
        size_bytes: parseInt(format.size || "0", 10),
        bit_depth: stream.bits_per_raw_sample || stream.bits_per_sample || null,
      },
      null,
      2
    )
  },
})

// ── 2. Convert ───────────────────────────────────────────────

export const convert = tool({
  description:
    "Convert audio between formats (wav, flac, mp3, opus, ogg, aac, pcm). " +
    "Optionally resample and/or change channel count. Output path is auto-generated if omitted.",
  args: {
    input: tool.schema.string().describe("Input audio file path"),
    format: tool.schema
      .enum(["wav", "flac", "mp3", "opus", "ogg", "aac", "pcm"])
      .describe("Target format"),
    sample_rate: tool.schema.number().optional().describe("Target sample rate (e.g. 22050, 44100, 48000)"),
    channels: tool.schema.number().optional().describe("Target channels (1=mono, 2=stereo)"),
    output: tool.schema.string().optional().describe("Output file path (auto-generated if omitted)"),
  },
  async execute(args) {
    assertFile(args.input)

    const ext = args.format === "pcm" ? "raw" : args.format
    const out = args.output || tmpAudio(ext)

    const filters: string[] = []
    if (args.sample_rate) filters.push(`-ar ${args.sample_rate}`)
    if (args.channels) filters.push(`-ac ${args.channels}`)

    // Codec mapping
    const codecMap: Record<string, string> = {
      wav: "-c:a pcm_s16le",
      flac: "-c:a flac",
      mp3: "-c:a libmp3lame -b:a 192k",
      opus: "-c:a libopus -b:a 128k",
      ogg: "-c:a libvorbis -q:a 6",
      aac: "-c:a aac -b:a 192k",
      pcm: "-f s16le -c:a pcm_s16le",
    }
    const codec = codecMap[args.format] || ""

    run(`ffmpeg -y -i "${args.input}" ${filters.join(" ")} ${codec} "${out}"`)

    return JSON.stringify({ output: out, format: args.format }, null, 2)
  },
})

// ── 3. Trim ──────────────────────────────────────────────────

export const trim = tool({
  description:
    "Trim audio by start and/or end time. Times use HH:MM:SS.ms or seconds format. " +
    "Copies codec by default (fast, lossless for same-format).",
  args: {
    input: tool.schema.string().describe("Input audio file path"),
    start: tool.schema.string().optional().describe("Start time (e.g. '0:01:30' or '90.5'). Default: beginning."),
    end: tool.schema.string().optional().describe("End time (e.g. '0:03:00' or '180'). Default: end of file."),
    output: tool.schema.string().optional().describe("Output file path (auto-generated if omitted)"),
  },
  async execute(args) {
    assertFile(args.input)
    const ext = extname(args.input).slice(1) || "wav"
    const out = args.output || tmpAudio(ext)

    const parts = ["-y", "-i", `"${args.input}"`]
    if (args.start) parts.push(`-ss ${args.start}`)
    if (args.end) parts.push(`-to ${args.end}`)
    parts.push("-c copy", `"${out}"`)

    run(`ffmpeg ${parts.join(" ")}`)
    return JSON.stringify({ output: out }, null, 2)
  },
})

// ── 4. Concat ────────────────────────────────────────────────

export const concat = tool({
  description:
    "Concatenate multiple audio files into one. All inputs should have the same " +
    "sample rate and channels (use audio_convert first if needed). Uses ffmpeg concat demuxer.",
  args: {
    inputs: tool.schema.array(tool.schema.string()).describe("Ordered list of audio file paths to concatenate"),
    output: tool.schema.string().optional().describe("Output file path (auto-generated if omitted)"),
  },
  async execute(args) {
    if (args.inputs.length < 2) return "Error: need at least 2 files to concatenate"

    for (const f of args.inputs) assertFile(f)

    const ext = extname(args.inputs[0]).slice(1) || "wav"
    const out = args.output || tmpAudio(ext)

    // Write concat list
    const listPath = tmpAudio("txt")
    const listContent = args.inputs.map((f) => `file '${f}'`).join("\n")
    writeFileSync(listPath, listContent)

    try {
      run(`ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${out}"`)
      return JSON.stringify({ output: out, files_joined: args.inputs.length }, null, 2)
    } finally {
      try { unlinkSync(listPath) } catch {}
    }
  },
})

// ── 5. Normalize ─────────────────────────────────────────────

export const normalize = tool({
  description:
    "Loudness normalize audio to EBU R128 standard (-16 LUFS target, -1.5 dBTP, 11 LRA). " +
    "Two-pass: measures first, then applies. Ensures consistent volume across files.",
  args: {
    input: tool.schema.string().describe("Input audio file path"),
    target_lufs: tool.schema.number().optional().describe("Target loudness in LUFS (default: -16)"),
    output: tool.schema.string().optional().describe("Output file path (auto-generated if omitted)"),
  },
  async execute(args) {
    assertFile(args.input)
    const ext = extname(args.input).slice(1) || "wav"
    const out = args.output || tmpAudio(ext)
    const lufs = args.target_lufs ?? -16

    // Two-pass loudnorm for accuracy
    // Pass 1: measure
    const measureRaw = run(
      `ffmpeg -i "${args.input}" -af loudnorm=I=${lufs}:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 | tail -12`,
      60_000
    )

    // Try to extract measured values for pass 2
    try {
      const m = JSON.parse(measureRaw)
      const filter =
        `loudnorm=I=${lufs}:TP=-1.5:LRA=11:` +
        `measured_I=${m.input_i}:measured_TP=${m.input_tp}:` +
        `measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:` +
        `offset=${m.target_offset}:linear=true`
      run(`ffmpeg -y -i "${args.input}" -af "${filter}" "${out}"`, 120_000)
    } catch {
      // Fallback: single-pass
      run(`ffmpeg -y -i "${args.input}" -af "loudnorm=I=${lufs}:TP=-1.5:LRA=11" "${out}"`, 120_000)
    }

    return JSON.stringify({ output: out, target_lufs: lufs }, null, 2)
  },
})

// ── 6. Silence detect ────────────────────────────────────────

export const silence = tool({
  description:
    "Detect silence regions in an audio file. Returns start/end timestamps for each silent segment. " +
    "Useful for finding natural break points, dead air, or validating recordings.",
  args: {
    input: tool.schema.string().describe("Input audio file path"),
    threshold_db: tool.schema.number().optional().describe("Silence threshold in dB (default: -30). More negative = quieter required."),
    min_duration: tool.schema.number().optional().describe("Minimum silence duration in seconds (default: 0.5)"),
  },
  async execute(args) {
    assertFile(args.input)
    const db = args.threshold_db ?? -30
    const dur = args.min_duration ?? 0.5

    // ffmpeg silencedetect outputs to stderr
    let raw: string
    try {
      raw = execSync(
        `ffmpeg -i "${args.input}" -af silencedetect=noise=${db}dB:d=${dur} -f null - 2>&1`,
        { encoding: "utf-8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] }
      )
    } catch (e: any) {
      raw = e?.stdout?.toString?.() || e?.stderr?.toString?.() || ""
    }

    // Parse silence_start / silence_end / silence_duration lines
    const regions: Array<{ start: number; end: number; duration: number }> = []
    const lines = raw.split("\n")
    let currentStart: number | null = null

    for (const line of lines) {
      const startMatch = line.match(/silence_start:\s*([\d.]+)/)
      const endMatch = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/)

      if (startMatch) {
        currentStart = parseFloat(startMatch[1])
      }
      if (endMatch && currentStart !== null) {
        regions.push({
          start: currentStart,
          end: parseFloat(endMatch[1]),
          duration: parseFloat(endMatch[2]),
        })
        currentStart = null
      }
    }

    return JSON.stringify(
      {
        file: args.input,
        threshold_db: db,
        min_duration: dur,
        silence_regions: regions,
        count: regions.length,
      },
      null,
      2
    )
  },
})

// ── 7. Split on silence ──────────────────────────────────────

export const split = tool({
  description:
    "Split audio file on silence boundaries into numbered segments. " +
    "Useful for chunking long recordings into natural segments before TTS or transcription. " +
    "Output files are named <basename>-001.ext, <basename>-002.ext, etc.",
  args: {
    input: tool.schema.string().describe("Input audio file path"),
    threshold_db: tool.schema.number().optional().describe("Silence threshold in dB (default: -30)"),
    min_silence: tool.schema.number().optional().describe("Minimum silence duration to split on, in seconds (default: 0.5)"),
    output_dir: tool.schema.string().optional().describe("Output directory (default: same dir as input)"),
  },
  async execute(args) {
    assertFile(args.input)
    const db = args.threshold_db ?? -30
    const dur = args.min_silence ?? 0.5
    const ext = extname(args.input).slice(1) || "wav"
    const base = basename(args.input, `.${ext}`)
    const outDir = args.output_dir || dirname(args.input)

    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

    // Detect silence first
    let raw: string
    try {
      raw = execSync(
        `ffmpeg -i "${args.input}" -af silencedetect=noise=${db}dB:d=${dur} -f null - 2>&1`,
        { encoding: "utf-8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] }
      )
    } catch (e: any) {
      raw = e?.stdout?.toString?.() || e?.stderr?.toString?.() || ""
    }

    // Parse silence midpoints as split points
    const splitPoints: number[] = []
    const lines = raw.split("\n")
    let currentStart: number | null = null

    for (const line of lines) {
      const startMatch = line.match(/silence_start:\s*([\d.]+)/)
      const endMatch = line.match(/silence_end:\s*([\d.]+)/)
      if (startMatch) currentStart = parseFloat(startMatch[1])
      if (endMatch && currentStart !== null) {
        // Split at the midpoint of each silence region
        const end = parseFloat(endMatch[1])
        splitPoints.push((currentStart + end) / 2)
        currentStart = null
      }
    }

    if (splitPoints.length === 0) {
      return JSON.stringify({ error: "No silence boundaries found — try a less negative threshold_db", file: args.input }, null, 2)
    }

    // Get total duration
    const durationStr = run(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${args.input}"`)
    const totalDuration = parseFloat(durationStr)

    // Build segments: [0, sp1], [sp1, sp2], ..., [spN, end]
    const boundaries = [0, ...splitPoints, totalDuration]
    const outputs: string[] = []

    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i]
      const end = boundaries[i + 1]
      const num = String(i + 1).padStart(3, "0")
      const outPath = join(outDir, `${base}-${num}.${ext}`)
      run(`ffmpeg -y -i "${args.input}" -ss ${start} -to ${end} -c copy "${outPath}"`)
      outputs.push(outPath)
    }

    return JSON.stringify(
      { segments: outputs.length, files: outputs },
      null,
      2
    )
  },
})

// ── 8. Mix ───────────────────────────────────────────────────

export const mix = tool({
  description:
    "Mix (overlay) two audio files together. Useful for adding background music/ambience under speech. " +
    "The secondary input can be volume-adjusted. Output duration matches the longer input by default.",
  args: {
    primary: tool.schema.string().describe("Primary audio file (e.g. speech)"),
    secondary: tool.schema.string().describe("Secondary audio file (e.g. background music)"),
    secondary_volume: tool.schema.number().optional().describe("Volume multiplier for secondary (0.0-1.0, default: 0.3)"),
    duration: tool.schema.enum(["longest", "shortest", "first"]).optional().describe("Output duration: longest, shortest, or first (default: first)"),
    output: tool.schema.string().optional().describe("Output file path (auto-generated if omitted)"),
  },
  async execute(args) {
    assertFile(args.primary)
    assertFile(args.secondary)

    const ext = extname(args.primary).slice(1) || "wav"
    const out = args.output || tmpAudio(ext)
    const vol = args.secondary_volume ?? 0.3
    const dur = args.duration ?? "first"

    run(
      `ffmpeg -y -i "${args.primary}" -i "${args.secondary}" ` +
        `-filter_complex "[1:a]volume=${vol}[bg];[0:a][bg]amix=inputs=2:duration=${dur}:dropout_transition=2" ` +
        `"${out}"`,
      120_000
    )

    return JSON.stringify({ output: out }, null, 2)
  },
})

// ── 9. Waveform ──────────────────────────────────────────────

export const waveform = tool({
  description:
    "Generate an ASCII waveform visualization of an audio file. " +
    "Useful for quick visual inspection of audio amplitude without leaving the terminal. " +
    "Shows amplitude over time with configurable width and height.",
  args: {
    input: tool.schema.string().describe("Input audio file path"),
    width: tool.schema.number().optional().describe("Width in characters (default: 80)"),
    height: tool.schema.number().optional().describe("Height in lines (default: 20)"),
  },
  async execute(args) {
    assertFile(args.input)
    const width = args.width ?? 80
    const height = args.height ?? 20
    const halfH = Math.floor(height / 2)

    // Get raw PCM samples via ffmpeg — mono, 8kHz, s16le for compactness
    const tmpPcm = tmpAudio("raw")
    try {
      run(`ffmpeg -y -i "${args.input}" -ac 1 -ar 8000 -f s16le -c:a pcm_s16le "${tmpPcm}"`, 30_000)
      const pcm = readFileSync(tmpPcm)
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2)

      if (samples.length === 0) return "Empty audio file"

      // Downsample to `width` bins — take peak amplitude per bin
      const binSize = Math.max(1, Math.floor(samples.length / width))
      const peaks: number[] = []
      for (let i = 0; i < width; i++) {
        let max = 0
        const start = i * binSize
        const end = Math.min(start + binSize, samples.length)
        for (let j = start; j < end; j++) {
          const abs = Math.abs(samples[j])
          if (abs > max) max = abs
        }
        peaks.push(max / 32768) // normalize to 0..1
      }

      // Get duration for time axis
      const durationSec = samples.length / 8000
      const durStr = durationSec >= 60
        ? `${Math.floor(durationSec / 60)}m${Math.round(durationSec % 60)}s`
        : `${durationSec.toFixed(1)}s`

      // Render ASCII waveform — mirrored vertically
      const BLOCK = "\u2588" // full block
      const HALF = "\u2584"  // lower half block
      const lines: string[] = []

      for (let row = halfH; row >= -halfH; row--) {
        const threshold = Math.abs(row) / halfH
        let line = ""
        for (let col = 0; col < width; col++) {
          if (peaks[col] >= threshold + 0.5 / halfH) {
            line += BLOCK
          } else if (peaks[col] >= threshold) {
            line += HALF
          } else {
            line += " "
          }
        }
        lines.push(line)
      }

      // Time axis
      const timeAxis = `0s${" ".repeat(Math.max(0, width - 2 - durStr.length))}${durStr}`

      return [
        `File: ${basename(args.input)} | ${durStr} | ${samples.length} samples @ 8kHz`,
        "",
        ...lines,
        timeAxis,
      ].join("\n")
    } finally {
      try { unlinkSync(tmpPcm) } catch {}
    }
  },
})

// ── 10. Effects ──────────────────────────────────────────────

export const effects = tool({
  description:
    "Apply audio effects chain via ffmpeg filters. Supports: highpass, lowpass, " +
    "reverb (aecho), compressor (compand), speed change, pitch shift, fade in/out, " +
    "noise gate, and equalizer. Multiple effects are chained in order.",
  args: {
    input: tool.schema.string().describe("Input audio file path"),
    highpass: tool.schema.number().optional().describe("Highpass filter cutoff frequency in Hz (e.g. 80 to remove rumble)"),
    lowpass: tool.schema.number().optional().describe("Lowpass filter cutoff frequency in Hz (e.g. 8000 for telephone effect)"),
    speed: tool.schema.number().optional().describe("Playback speed multiplier (0.5=half speed, 2.0=double). Also changes pitch."),
    tempo: tool.schema.number().optional().describe("Tempo change without pitch shift (0.5-2.0). Uses atempo filter."),
    reverb: tool.schema.boolean().optional().describe("Add reverb effect (medium room)"),
    compress: tool.schema.boolean().optional().describe("Apply dynamic range compression (broadcast-style)"),
    fade_in: tool.schema.number().optional().describe("Fade in duration in seconds"),
    fade_out: tool.schema.number().optional().describe("Fade out duration in seconds"),
    gain_db: tool.schema.number().optional().describe("Volume adjustment in dB (e.g. 3 to boost, -6 to reduce)"),
    output: tool.schema.string().optional().describe("Output file path (auto-generated if omitted)"),
  },
  async execute(args) {
    assertFile(args.input)
    const ext = extname(args.input).slice(1) || "wav"
    const out = args.output || tmpAudio(ext)

    const filters: string[] = []

    if (args.highpass) filters.push(`highpass=f=${args.highpass}`)
    if (args.lowpass) filters.push(`lowpass=f=${args.lowpass}`)
    if (args.speed) filters.push(`atempo=${args.speed}`)
    if (args.tempo) {
      // atempo only supports 0.5-2.0, chain multiple for wider range
      let t = args.tempo
      while (t > 2.0) {
        filters.push("atempo=2.0")
        t /= 2.0
      }
      while (t < 0.5) {
        filters.push("atempo=0.5")
        t /= 0.5
      }
      filters.push(`atempo=${t}`)
    }
    if (args.reverb) {
      // Medium room reverb via aecho
      filters.push("aecho=0.8:0.88:60:0.4")
    }
    if (args.compress) {
      // Broadcast-style compression
      filters.push("compand=attacks=0.3:decays=0.8:points=-80/-900|-45/-15|-27/-9|0/-7|20/-7:gain=5")
    }
    if (args.gain_db !== undefined) {
      filters.push(`volume=${args.gain_db}dB`)
    }
    if (args.fade_in) {
      filters.push(`afade=t=in:d=${args.fade_in}`)
    }
    if (args.fade_out) {
      // Need duration for fade out — get it
      const durStr = run(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${args.input}"`)
      const dur = parseFloat(durStr)
      const st = Math.max(0, dur - args.fade_out)
      filters.push(`afade=t=out:st=${st}:d=${args.fade_out}`)
    }

    if (filters.length === 0) {
      return "Error: no effects specified. Provide at least one effect parameter."
    }

    const filterChain = filters.join(",")
    run(`ffmpeg -y -i "${args.input}" -af "${filterChain}" "${out}"`, 120_000)

    return JSON.stringify(
      { output: out, effects_applied: filters },
      null,
      2
    )
  },
})
