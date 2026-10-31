/**
 * Workspace tools — location/project and VCS info.
 */

import { tool } from "../lib/tool"
import { sdk, run } from "../lib/sdk.ts"
import { hostDescription } from "../lib/config.ts"

const loc = (directory?: string) => (directory ? { location: { directory } } : undefined)

export const path = tool({
  description: "Get the opencode server's resolved location and project for a directory (defaults to the serve's own location).",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    directory: tool.schema.string().optional().describe("Directory on the host to resolve"),
  },
  async execute(args) {
    return run(async () => sdk(args.host).location.get(loc(args.directory)))
  },
})

export const projects = tool({
  description: "List the projects known to the opencode server on the host.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
  },
  async execute(args) {
    return run(async () => sdk(args.host).project.list())
  },
})

export const vcs = tool({
  description: "Get git/VCS info for a project on the host: current and default branch, dirty files.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    directory: tool.schema.string().optional().describe("Project directory on the host (defaults to the serve's location)"),
  },
  async execute(args) {
    return run(async () => {
      const client = sdk(args.host)
      const [info, status] = await Promise.all([client.vcs.get(loc(args.directory)), client.vcs.status(loc(args.directory))])
      return { location: info.location, ...info.data, status: status.data }
    })
  },
})
