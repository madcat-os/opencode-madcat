import { Rpc } from "@opencode/plugin"
import { z } from "zod"

export const SupervisorRef = z.object({
  host: z.string(),
  sessionID: z.string(),
  claimedAt: z.number(),
})
export type SupervisorRef = z.infer<typeof SupervisorRef>

export const Hello = z.object({
  host: z.string(),
  version: z.string(),
  supervisor: SupervisorRef.optional(),
  workers: z.number().int().nonnegative(),
})
export type Hello = z.infer<typeof Hello>

export const Mesh = Rpc.define({
  id: "mesh",
  methods: {
    hello: {
      input: z.object({}),
      output: Hello,
    },
  },
  events: {},
})

export type Mesh = typeof Mesh
