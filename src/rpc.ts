import { Rpc } from "@opencode/plugin"
import { z } from "zod"

export const SupervisorRef = z.object({
  host: z.string(),
  sessionID: z.string(),
  claimedAt: z.number(),
})
export type SupervisorRef = z.infer<typeof SupervisorRef>

export const WorkerState = z.enum(["spawning", "idle", "busy", "error", "done", "lost"])
export type WorkerState = z.infer<typeof WorkerState>

export const Hello = z.object({
  host: z.string(),
  version: z.string(),
  supervisor: SupervisorRef.optional(),
  workers: z.number().int().nonnegative(),
})
export type Hello = z.infer<typeof Hello>

export const ClaimInput = z.object({
  host: z.string(),
  sessionID: z.string(),
  claimedAt: z.number(),
  force: z.boolean().optional(),
  release: z.boolean().optional(),
})
export type ClaimInput = z.infer<typeof ClaimInput>

export const ClaimOutput = z.object({
  ok: z.boolean(),
  held: SupervisorRef.optional(),
})
export type ClaimOutput = z.infer<typeof ClaimOutput>

export const WorkerInfo = z.object({
  sessionID: z.string(),
  name: z.string(),
  directory: z.string(),
  supervisor: SupervisorRef,
  state: WorkerState,
})
export type WorkerInfo = z.infer<typeof WorkerInfo>

export const Role = z.enum(["supervisor", "worker", "none"])
export type Role = z.infer<typeof Role>

export const Whoami = z.object({
  role: Role,
  host: z.string(),
  sessionID: z.string(),
  name: z.string().optional(),
  supervisor: SupervisorRef.optional(),
})
export type Whoami = z.infer<typeof Whoami>

export const Mesh = Rpc.define({
  id: "mesh",
  methods: {
    hello: {
      input: z.object({}),
      output: Hello,
    },
    claim: {
      input: ClaimInput,
      output: ClaimOutput,
    },
    register: {
      input: z.object({
        sessionID: z.string(),
        name: z.string(),
        directory: z.string(),
        supervisor: SupervisorRef,
      }),
      output: z.object({ ok: z.boolean() }),
      errors: {
        name_taken: z.object({ name: z.string(), sessionID: z.string() }),
      },
    },
    unregister: {
      input: z.object({ sessionID: z.string() }),
      output: z.object({ removed: z.boolean() }),
    },
    list: {
      input: z.object({}),
      output: z.object({ workers: z.array(WorkerInfo) }),
    },
    whoami: {
      input: z.object({ sessionID: z.string() }),
      output: Whoami,
    },
  },
  events: {
    supervisor: {
      schema: z.object({
        supervisor: SupervisorRef.optional(),
        released: z.boolean().optional(),
      }),
    },
    worker: {
      schema: z.object({
        sessionID: z.string(),
        name: z.string().optional(),
        removed: z.boolean().optional(),
      }),
    },
    roster: {
      schema: z.object({
        host: z.string(),
        sessionID: z.string(),
        name: z.string().optional(),
        state: WorkerState.optional(),
        removed: z.boolean().optional(),
      }),
    },
  },
})

export type Mesh = typeof Mesh
