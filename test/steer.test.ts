import { describe, expect, test } from "bun:test"
import { isNotFound } from "../src/index.ts"
import { NONCE_TTL, State } from "../src/state.ts"
import { messageID, supervisorAddress } from "../src/steer.ts"

describe("messageID", () => {
  test("has the msg_ prefix and sorts by time", () => {
    const a = messageID(1_000)
    const b = messageID(2_000)
    expect(a.startsWith("msg_")).toBe(true)
    expect(a < b).toBe(true)
    expect(messageID()).not.toBe(messageID())
  })
})

describe("supervisorAddress", () => {
  test("names the supervisor 'super'", () => {
    expect(supervisorAddress({ host: "fuji", sessionID: "ses_x", claimedAt: 1 })).toEqual({
      host: "fuji",
      sessionID: "ses_x",
      name: "super",
    })
  })
})

describe("isNotFound", () => {
  test("recognises the client's SessionNotFoundError and the mesh no_session error", () => {
    expect(isNotFound({ _tag: "SessionNotFoundError", sessionID: "ses_x" })).toBe(true)
    expect(isNotFound({ type: "no_session", message: "x" })).toBe(true)
    expect(isNotFound(new Error("boom"))).toBe(false)
    expect(isNotFound(undefined)).toBe(false)
  })
})

function memoryStorage() {
  const map = new Map<string, unknown>()
  return {
    get: async (key: string) => map.get(key),
    set: async (key: string, value: unknown) => void map.set(key, value),
    remove: async (key: string) => void map.delete(key),
    scan: async ({ prefix }: { prefix: string }) => ({
      entries: [...map.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    }),
  } as unknown as ConstructorParameters<typeof State>[0]
}

describe("State nonces", () => {
  const from = { host: "fuji", sessionID: "ses_s", name: "super" }

  test("takeNonce is single-use", async () => {
    const state = new State(memoryStorage())
    await state.setNonce("n1", { from, kind: "order", msgID: "msg_1", createdAt: 100 })
    expect(await state.takeNonce("n1", 200)).toEqual({ from, kind: "order", msgID: "msg_1", createdAt: 100 })
    expect(await state.takeNonce("n1", 200)).toBeUndefined()
  })

  test("expired nonces are dropped", async () => {
    const state = new State(memoryStorage())
    await state.setNonce("n2", { from, kind: "ask", msgID: "msg_2", createdAt: 0 })
    expect(await state.takeNonce("n2", NONCE_TTL + 1)).toBeUndefined()
  })

  test("pruneNonces removes only stale entries", async () => {
    const state = new State(memoryStorage())
    await state.setNonce("old", { from, kind: "order", msgID: "msg_3", createdAt: 0 })
    await state.setNonce("new", { from, kind: "order", msgID: "msg_4", createdAt: NONCE_TTL })
    expect(await state.pruneNonces(NONCE_TTL + 1)).toBe(1)
    expect(await state.takeNonce("new", NONCE_TTL + 1)).toBeDefined()
  })
})
