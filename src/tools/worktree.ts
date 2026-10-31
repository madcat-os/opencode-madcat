/**
 * Git worktree tools — list, create, remove, refresh isolated sandbox worktrees
 * for an opencode project. Wraps the V2 /api/worktree endpoints, which are
 * project-scoped: pass the project directory and the tool resolves its ID.
 *
 * Each worktree is a separate git working tree on its own branch, letting
 * parallel worker sessions write code in isolation without colliding on a
 * shared checkout. Pair with the messages_* / control_* tools to give a
 * worker its own branch before dispatching code-writing work.
 */

import { tool } from "../lib/tool"
import { hostDescription } from "../lib/config.ts"
import { sdk, run, projectId } from "../lib/sdk.ts"

const projectArg = () =>
  tool.schema.string().optional().describe("Project directory on the host (defaults to the serve's own project)")

export const list = tool({
  description: "List all worktrees for an opencode project, including the root checkout.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    directory: projectArg(),
  },
  async execute(args) {
    return run(async () => {
      const projectID = await projectId(args.host, args.directory)
      return { projectID, worktrees: await sdk(args.host).worktree.list({ projectID }) }
    })
  },
})

export const create = tool({
  description:
    "Create a new git worktree for an opencode project on its own branch, running any configured startup command. Use to give a worker session an isolated checkout before parallel code work.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    name: tool.schema.string().optional().describe("Worktree name (auto-generated when omitted)"),
    branch: tool.schema.string().optional().describe("Starting ref / branch to check out"),
    parent: tool.schema.string().optional().describe("Parent directory to create the worktree under (defaults to the project's worktree directory)"),
    directory: projectArg(),
  },
  async execute(args) {
    return run(async () => {
      const projectID = await projectId(args.host, args.directory)
      return sdk(args.host).worktree.create({ projectID, name: args.name, branch: args.branch, directory: args.parent })
    })
  },
})

export const remove = tool({
  description: "Remove a git worktree. Pass force=true to discard uncommitted changes.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    worktree: tool.schema.string().describe("Worktree directory to remove (the absolute path from worktree_list)"),
    force: tool.schema.boolean().optional().describe("Discard uncommitted changes (default: false)"),
    directory: projectArg(),
  },
  async execute(args) {
    return run(async () => {
      const projectID = await projectId(args.host, args.directory)
      await sdk(args.host).worktree.remove({ projectID, directory: args.worktree, force: args.force ?? false })
      return { status: "removed", directory: args.worktree }
    })
  },
})

export const refresh = tool({
  description: "Rescan a project's worktrees on disk, pruning missing directories and discovering new ones.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    directory: projectArg(),
  },
  async execute(args) {
    return run(async () => {
      const projectID = await projectId(args.host, args.directory)
      await sdk(args.host).worktree.refresh({ projectID })
      return { projectID, worktrees: await sdk(args.host).worktree.list({ projectID }) }
    })
  },
})
