/**
 * Auth tools — set, list, and remove provider credentials.
 *
 * V2 models provider auth as integrations + credentials: `set` connects an
 * integration with an API key, `remove` deletes a stored credential entry.
 */

import { tool } from "../lib/tool"
import { sdk, run } from "../lib/sdk.ts"
import { hostDescription } from "../lib/config.ts"

export const set = tool({
  description: "Set an API key credential for an LLM provider / integration (e.g. anthropic, openai).",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    provider: tool.schema.string().describe("Integration ID (e.g. anthropic, google)"),
    key: tool.schema.string().describe("API key"),
    label: tool.schema.string().optional().describe("Label for the stored credential"),
  },
  async execute(args) {
    return run(async () => {
      await sdk(args.host).integration.connect.key({ integrationID: args.provider, key: args.key, label: args.label })
      return { status: "set", provider: args.provider }
    })
  },
})

export const list = tool({
  description: "List stored credentials (id, integration, label, active) on the host. Secrets are not returned.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
  },
  async execute(args) {
    return run(async () =>
      (await sdk(args.host).credential.list()).map((c) => ({
        id: c.id,
        integrationID: c.integrationID,
        label: c.label,
        active: c.active,
        type: c.value?.type,
      })),
    )
  },
})

export const remove = tool({
  description: "Remove stored credentials for a provider. Pass a credential ID from auth_list, or an integration ID to remove all of its credentials.",
  args: {
    host: tool.schema.string().describe(hostDescription()),
    provider: tool.schema.string().describe("Credential ID or integration ID"),
  },
  async execute(args) {
    return run(async () => {
      const client = sdk(args.host)
      const all = await client.credential.list()
      const targets = all.filter((c) => c.id === args.provider || c.integrationID === args.provider)
      if (targets.length === 0) return { status: "not-found", provider: args.provider }
      for (const c of targets) await client.credential.remove({ credentialID: c.id })
      return { status: "removed", provider: args.provider, count: targets.length }
    })
  },
})
