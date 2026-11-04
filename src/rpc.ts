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

export const RosterRow = z.object({
  host: z.string(),
  sessionID: z.string(),
  name: z.string(),
  directory: z.string(),
  state: WorkerState,
  lastSeen: z.number(),
})
export type RosterRow = z.infer<typeof RosterRow>

export const RosterView = z.object({
  host: z.string().describe("the host answering"),
  supervisor: SupervisorRef.optional(),
  entries: z.array(RosterRow).describe("empty unless the supervisor lives on this host"),
})
export type RosterView = z.infer<typeof RosterView>

export const MessageKind = z.enum(["order", "ask", "report", "answer"])
export type MessageKind = z.infer<typeof MessageKind>

export const Delivery = z.enum(["steer", "queue"])
export type Delivery = z.infer<typeof Delivery>

export const MeshAddress = z.object({
  host: z.string(),
  sessionID: z.string(),
  name: z.string(),
})
export type MeshAddress = z.infer<typeof MeshAddress>

export const DeliverInput = z.object({
  to: z.string().describe("target sessionID on the receiving host"),
  from: MeshAddress,
  msgID: z.string().startsWith("msg_").describe("session message id; becomes the inbox id on the receiving host"),
  kind: MessageKind,
  body: z.string(),
  delivery: Delivery,
})
export type DeliverInput = z.infer<typeof DeliverInput>

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
    notify: {
      input: z.object({
        host: z.string().describe("host the worker lives on"),
        sessionID: z.string(),
        state: WorkerState,
        at: z.number(),
        removed: z.boolean().optional().describe("the session was deleted on its host"),
      }),
      output: z.object({ known: z.boolean() }),
    },
    roster: {
      input: z.object({ refresh: z.boolean().optional().describe("re-query every peer first") }),
      output: RosterView,
    },
    read: {
      input: z.object({
        host: z.string(),
        sessionID: z.string(),
        tail: z.number().int().positive().optional(),
      }),
      output: z.object({ text: z.string() }),
      errors: { unauthorized: z.object({ reason: z.string() }) },
    },
    deliver: {
      input: DeliverInput,
      output: z.object({ delivered: z.boolean() }),
      errors: {
        unauthorized: z.object({ reason: z.string() }),
        no_session: z.object({ sessionID: z.string() }),
      },
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
    message: {
      schema: z.object({
        from: MeshAddress,
        to: z.string(),
        kind: MessageKind,
        msgID: z.string(),
      }),
    },
  },
})

export type Mesh = typeof Mesh
