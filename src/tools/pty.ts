/**
 * PTY (terminal) session tools — create, get, list, remove.
 */

import { tool } from "../lib/tool"
import { sdk, run } from "../lib/sdk.ts"
import { hostDescription } from "../lib/config.ts"

const loc = (directory?: string) => (directory ? { location: { directory } } : undefined)
const dirArg = () => tool.schema.string().optional().describe("Project directory on the host (defaults to the serve's location)")

export const create = tool({
  description: "Create a new PTY (terminal) session on the opencode server.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    command: tool.schema.string().optional().describe("Program to run (defaults to the user's shell)"),
    args: tool.schema.array(tool.schema.string()).optional().describe("Arguments for the program"),
    cwd: tool.schema.string().optional().describe("Working directory for the terminal"),
    title: tool.schema.string().optional().describe("Terminal title"),
    directory: dirArg(),
  },
  async execute(args) {
    return run(async () =>
      (
        await sdk(args.host).pty.create({
          ...loc(args.directory),
          command: args.command,
          args: args.args,
          cwd: args.cwd,
          title: args.title,
        })
      ).data,
    )
  },
})

export const get = tool({
  description: "Get info about a specific PTY session.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("PTY session ID"),
    directory: dirArg(),
  },
  async execute(args) {
    return run(async () => (await sdk(args.host).pty.get({ ...loc(args.directory), ptyID: args.id })).data)
  },
})

export const list = tool({
  description: "List all PTY (terminal) sessions on the opencode server.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    directory: dirArg(),
  },
  async execute(args) {
    return run(async () => (await sdk(args.host).pty.list(loc(args.directory))).data)
  },
})

export const remove = tool({
  description: "Remove a PTY session by ID.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    id: tool.schema.string().describe("PTY session ID"),
    directory: dirArg(),
  },
  async execute(args) {
    return run(async () => {
      await sdk(args.host).pty.remove({ ...loc(args.directory), ptyID: args.id })
      return { status: "removed", id: args.id }
    })
  },
})
