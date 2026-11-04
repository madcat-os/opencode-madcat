import { describe, expect, test } from "bun:test"
import { VERSION, formatHosts, formatRoster } from "../src/index.ts"
import { describe as describeError, same } from "../src/supervisor.ts"

describe("formatHosts", () => {
  test("marks self, mismatch, and unreachable hosts", () => {
    const out = formatHosts([
      {
        name: "fuji",
        self: true,
        url: "http://localhost:4096",
        directory: "/p",
        ok: true,
        hello: { host: "fuji", version: VERSION, workers: 2 },
        mismatch: false,
      },
      {
        name: "sin",
        self: false,
        url: "http://sin:4096",
        ok: true,
        hello: {
          host: "sin",
          version: "0.0.1",
          workers: 1,
          supervisor: { host: "fuji", sessionID: "ses_x", claimedAt: 1 },
        },
        mismatch: true,
      },
      {
        name: "forge",
        self: false,
        url: "http://forge:4096",
        ok: false,
        error: "rpc.unavailable: RPC is unavailable: mesh",
      },
    ])
    const lines = out.split("\n")
    expect(lines[0]).toBe(`● fuji (self)  v${VERSION} · no supervisor · 2 workers · dir /p`)
    expect(lines[1]).toBe(`! sin  version 0.0.1 ≠ ${VERSION} · supervisor fuji/ses_x · 1 worker · no default dir`)
    expect(lines[2]).toBe("✗ forge  unreachable: rpc.unavailable: RPC is unavailable: mesh")
  })
})

describe("formatRoster", () => {
  test("empty roster", () => {
    expect(formatRoster([])).toBe("No workers in the roster.")
  })

  test("one row per entry with glyph, state and age", () => {
    const now = 100_000
    const out = formatRoster(
      [
        { host: "fuji", sessionID: "ses_a", name: "indexer", directory: "/a", state: "busy", lastSeen: now - 5_000 },
        { host: "sin", sessionID: "ses_b", name: "reviewer", directory: "/b", state: "lost", lastSeen: now - 300_000 },
      ],
      now,
    )
    expect(out).toBe("● fuji/indexer  busy  5s  ses_a  /a\n? sin/reviewer  lost  5m  ses_b  /b")
  })
})

describe("supervisor helpers", () => {
  test("same compares host and sessionID only", () => {
    expect(same({ host: "a", sessionID: "s" }, { host: "a", sessionID: "s", claimedAt: 9 } as never)).toBe(true)
    expect(same({ host: "a", sessionID: "s" }, { host: "b", sessionID: "s" })).toBe(false)
  })

  test("describe handles Error, rpc failure objects, and primitives", () => {
    expect(describeError(new Error("boom"))).toBe("boom")
    expect(describeError({ type: "rpc.unavailable", message: "no" })).toBe("rpc.unavailable: no")
    expect(describeError({ message: "plain" })).toBe("plain")
    expect(describeError(42)).toBe("42")
  })
})
