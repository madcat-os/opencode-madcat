import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { PERM, registerAgents } from "../src/agents.ts"

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }
type Agent = { id: string; mode: string; permissions: Rule[]; [k: string]: unknown }

const base = (id: string, mode = "primary"): Agent => ({ id, mode, permissions: [{ action: "*", resource: "*", effect: "allow" }] })

async function agents(): Promise<Map<string, Agent>> {
  const map = new Map<string, Agent>([
    ["build", base("build")],
    ["general", base("general", "subagent")],
    ["explore", { ...base("explore", "subagent"), permissions: [{ action: "*", resource: "*", effect: "deny" }] }],
  ])
  const editor = {
    list: () => [...map.values()],
    get: (id: string) => map.get(id),
    update: (id: string, fn: (a: Agent) => void) => {
      const a = map.get(id) ?? base(id)
      map.set(id, a)
      fn(a)
    },
  }
  const ctx = { agent: { transform: async (fn: (e: typeof editor) => void) => fn(editor) } } as unknown as Plugin.Context
  await registerAgents(ctx)
  return map
}

// Mirrors packages/core/src/tool.ts `whollyDisabled` + util/wildcard `match`.
const match = (input: string, pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(input)
const visible = (agent: Agent, permission: string) => {
  const rule = agent.permissions.findLast((r) => match(permission, r.action))
  return !(rule?.resource === "*" && rule.effect === "deny")
}

describe("mesh tool visibility by agent", () => {
  test("super sees supervisor + common tools, not worker tools", async () => {
    const a = (await agents()).get("super")!
    expect(visible(a, PERM.super)).toBe(true)
    expect(visible(a, PERM.common)).toBe(true)
    expect(visible(a, PERM.worker)).toBe(false)
  })

  test("worker sees worker + common tools, not supervisor tools", async () => {
    const a = (await agents()).get("worker")!
    expect(visible(a, PERM.worker)).toBe(true)
    expect(visible(a, PERM.common)).toBe(true)
    expect(visible(a, PERM.super)).toBe(false)
  })

  test("every other agent, including subagents, sees no mesh tools", async () => {
    const map = await agents()
    for (const id of ["build", "general", "explore"]) {
      for (const p of Object.values(PERM)) expect(visible(map.get(id)!, p)).toBe(false)
    }
  })
})
