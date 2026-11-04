import { describe, expect, test } from "bun:test"
import { age, counts, degraded, footer, notable, sortRows, summary } from "../src/view.ts"

const row = (host: string, name: string, state: "busy" | "idle" | "spawning" | "done" | "error" | "lost") => ({
  host,
  name,
  state,
})

describe("view", () => {
  test("age buckets", () => {
    expect(age(-5)).toBe("0s")
    expect(age(42_000)).toBe("42s")
    expect(age(5 * 60_000)).toBe("5m")
    expect(age(3 * 3_600_000)).toBe("3h")
  })

  test("sortRows puts problems first, then busy, then the rest by host/name", () => {
    const rows = [
      row("sin", "b", "idle"),
      row("fuji", "a", "busy"),
      row("sin", "a", "lost"),
      row("fuji", "z", "error"),
      row("fuji", "c", "idle"),
    ]
    expect(sortRows(rows).map((r) => `${r.host}/${r.name}`)).toEqual(["fuji/z", "sin/a", "fuji/a", "fuji/c", "sin/b"])
  })

  test("counts, footer and summary", () => {
    const c = counts([
      row("fuji", "a", "busy"),
      row("sin", "b", "idle"),
      row("sin", "c", "spawning"),
      row("junk", "d", "lost"),
    ])
    expect(c).toEqual({ total: 4, hosts: 3, busy: 2, idle: 1, bad: 1 })
    expect(footer(c)).toBe("MESH 4 ●2 ○1 ✗1")
    expect(footer(counts([]))).toBe("MESH 0")
    expect(summary(c)).toBe("3 hosts · 4 workers · 1 need attention")
    expect(summary(counts([row("fuji", "a", "idle")]))).toBe("1 host · 1 worker")
  })

  test("notable and degraded", () => {
    expect(notable("report")).toBe(true)
    expect(notable("ask")).toBe(true)
    expect(notable("order")).toBe(false)
    expect(degraded("busy", "error")).toBe(true)
    expect(degraded(undefined, "lost")).toBe(true)
    expect(degraded("lost", "lost")).toBe(false)
    expect(degraded("busy", "idle")).toBe(false)
    expect(degraded("busy", undefined)).toBe(false)
  })
})
