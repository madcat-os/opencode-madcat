/**
 * Server info tools — agents, commands, health, providers, models, plugins.
 */

import { tool } from "../lib/tool"
import { sdk, run } from "../lib/sdk.ts"
import { hostDescription } from "../lib/config.ts"

const loc = (directory?: string) => (directory ? { location: { directory } } : undefined)
const dirArg = () => tool.schema.string().optional().describe("Project directory on the host (defaults to the serve's location)")

export const agents = tool({
  description: "List all available opencode agents (core, phone, build, etc.) with their model, description, and config.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    directory: dirArg(),
  },
  async execute(args) {
    return run(async () => (await sdk(args.host).agent.list(loc(args.directory))).data)
  },
})

export const commands = tool({
  description: "List all available opencode slash commands.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    directory: dirArg(),
  },
  async execute(args) {
    return run(async () => (await sdk(args.host).command.list(loc(args.directory))).data)
  },
})

export const health = tool({
  description: "Check opencode server health: version, pid, listening URLs, and resolved location.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
  },
  async execute(args) {
    return run(async () => {
      const client = sdk(args.host)
      const [info, location] = await Promise.all([client.server.info(), client.location.get()])
      return { ...info, location }
    })
  },
})

export const providers = tool({
  description: "List all configured LLM providers (anthropic, ollama, vllm, etc.).",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    directory: dirArg(),
  },
  async execute(args) {
    return run(async () => (await sdk(args.host).provider.list(loc(args.directory))).data)
  },
})

export const models = tool({
  description: "List the models available on the host, optionally filtered by provider, plus the default selection.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    provider: tool.schema.string().optional().describe("Only models from this provider ID"),
    directory: dirArg(),
  },
  async execute(args) {
    return run(async () => {
      const client = sdk(args.host)
      const [list, def] = await Promise.all([client.model.list(loc(args.directory)), client.model.default(loc(args.directory))])
      const models = (list as any).data ?? list
      const filtered = args.provider ? models.filter((m: any) => m.providerID === args.provider) : models
      return { default: (def as any).data ?? def, models: filtered }
    })
  },
})

export const plugins = tool({
  description: "List the plugins active on the host with their source and state.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    directory: dirArg(),
  },
  async execute(args) {
    return run(async () => (await sdk(args.host).plugin.list(loc(args.directory))).data)
  },
})
