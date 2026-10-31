/**
 * Local audio playback — spawns the platform player as a child process.
 *
 * Replaces the madcat-audio NAPI binding (rodio). macOS uses `afplay`;
 * Linux uses the first of `pw-play`, `paplay`, `aplay` found on PATH. Every
 * spawned player is tracked so `stopAll()` / `isPlaying()` work and so the
 * caller can await `exited` for a real completion signal instead of
 * guessing the clip length.
 */

import { existsSync } from "node:fs"
import { delimiter } from "node:path"

export interface Playback {
  path: string
  pid: number
  startedAt: number
  /** Resolves with the player's exit code once playback ends (or is stopped). */
  exited: Promise<number>
}

export interface PlayOptions {
  /** Resolve only after the player exits (default false). */
  wait?: boolean
}

const LINUX_PLAYERS = ["pw-play", "paplay", "aplay"]

let _player: string[] | null | undefined

function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter)
  return dirs.some((d) => d && existsSync(`${d}/${bin}`))
}

/** Player argv prefix for this host, or null when no player is installed. */
export function playerCommand(): string[] | null {
  if (_player !== undefined) return _player
  if (process.platform === "darwin") {
    _player = onPath("afplay") ? ["afplay"] : null
  } else {
    const found = LINUX_PLAYERS.find(onPath)
    _player = found ? [found] : null
  }
  return _player
}

export function playerName(): string | null {
  return playerCommand()?.[0] ?? null
}

const active = new Map<number, { proc: ReturnType<typeof Bun.spawn>; playback: Playback }>()

/**
 * Start playing `path`. Throws if no player is available or the player fails
 * to launch. With `wait` the promise resolves after the player exits; a
 * non-zero exit (other than a `stopAll` kill) is thrown.
 */
export async function play(path: string, opts: PlayOptions = {}): Promise<Playback> {
  const cmd = playerCommand()
  if (!cmd) {
    throw new Error(
      process.platform === "darwin"
        ? "audio: afplay not found"
        : `audio: no player on PATH (tried ${LINUX_PLAYERS.join(", ")})`,
    )
  }
  if (!existsSync(path)) throw new Error(`audio: file not found: ${path}`)

  const proc = Bun.spawn([...cmd, path], { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
  const stderr = new Response(proc.stderr).text().catch(() => "")
  const exited = proc.exited.then((code) => {
    active.delete(proc.pid)
    const wasStopped = stopped.delete(proc.pid)
    return wasStopped ? 0 : code
  })
  const playback: Playback = { path, pid: proc.pid, startedAt: Date.now(), exited }
  active.set(proc.pid, { proc, playback })

  if (opts.wait) {
    const code = await exited
    if (code !== 0) {
      const err = (await stderr).trim().split("\n").pop() ?? ""
      throw new Error(`audio: ${cmd[0]} exited ${code}${err ? `: ${err}` : ""}`)
    }
  }
  return playback
}

/** PIDs killed by stopAll — their non-zero exit is expected, reported as 0. */
const stopped = new Set<number>()

/** Kill every tracked player. Returns how many were stopped. */
export function stopAll(): number {
  let n = 0
  for (const { proc } of active.values()) {
    stopped.add(proc.pid)
    try {
      proc.kill()
      n++
    } catch {
      /* already gone */
    }
  }
  return n
}

export function isPlaying(): boolean {
  return active.size > 0
}

/** Currently running playbacks (for diagnostics). */
export function playing(): Playback[] {
  return [...active.values()].map((a) => a.playback)
}

/**
 * Report what the host can do. Never throws; nothing to initialise since
 * playback is a spawn per clip.
 */
export function initAudio(): Promise<{ player: string | null }> {
  const player = playerName()
  if (!player) console.warn("[audio] no local player found; tts_speak playback will fail")
  return Promise.resolve({ player })
}
