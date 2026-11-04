import type { MessageKind, RosterRow, WorkerState } from "./rpc.ts"

/** Presentation helpers shared by the TUI part and tool output. Pure; no OpenCode imports. */

export const GLYPH: Record<WorkerState, string> = {
  busy: "●",
  idle: "○",
  spawning: "◌",
  done: "✓",
  error: "✗",
  lost: "?",
}

export type Tone = "accent" | "muted" | "warning" | "error" | "success"

export const TONE: Record<WorkerState, Tone> = {
  busy: "accent",
  idle: "muted",
  spawning: "warning",
  done: "success",
  error: "error",
  lost: "error",
}

export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

const ORDER: Record<WorkerState, number> = { error: 0, lost: 1, busy: 2, spawning: 3, idle: 4, done: 5 }

/** Problems first, then busy, then the rest; stable by host/name within a state. */
export function sortRows<T extends Pick<RosterRow, "host" | "name" | "state">>(rows: readonly T[]): T[] {
  return rows.toSorted(
    (a, b) => ORDER[a.state] - ORDER[b.state] || `${a.host}/${a.name}`.localeCompare(`${b.host}/${b.name}`),
  )
}

export interface Counts {
  total: number
  hosts: number
  busy: number
  idle: number
  bad: number
}

export function counts(rows: readonly Pick<RosterRow, "host" | "state">[]): Counts {
  return {
    total: rows.length,
    hosts: new Set(rows.map((r) => r.host)).size,
    busy: rows.filter((r) => r.state === "busy" || r.state === "spawning").length,
    idle: rows.filter((r) => r.state === "idle" || r.state === "done").length,
    bad: rows.filter((r) => r.state === "error" || r.state === "lost").length,
  }
}

/** `MESH 4 ●2 ○1 ✗1`; zero buckets are omitted. */
export function footer(c: Counts): string {
  const parts = [`MESH ${c.total}`]
  if (c.busy) parts.push(`●${c.busy}`)
  if (c.idle) parts.push(`○${c.idle}`)
  if (c.bad) parts.push(`✗${c.bad}`)
  return parts.join(" ")
}

/** `3 hosts · 4 workers · 1 lost` */
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`

export function summary(c: Counts): string {
  const parts = [plural(c.hosts, "host"), plural(c.total, "worker")]
  if (c.bad) parts.push(`${c.bad} need attention`)
  return parts.join(" · ")
}

/** Messages that should raise a toast on the supervisor's terminal. */
export function notable(kind: MessageKind): boolean {
  return kind === "report" || kind === "ask"
}

/** A roster transition worth an error toast: into error/lost from anything else. */
export function degraded(prev: WorkerState | undefined, next: WorkerState | undefined): boolean {
  if (!next || prev === next) return false
  return next === "error" || next === "lost"
}

export function short(id: string, n = 10): string {
  return id.length > n ? `${id.slice(0, n)}…` : id
}
