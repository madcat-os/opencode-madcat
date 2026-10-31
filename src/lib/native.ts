/**
 * EEMS store/index resolution for tool calls.
 *
 * Pure TypeScript — `MemoryStore` and `CodeIndex` live in eems.ts and talk
 * to Postgres with the `postgres` package. No NAPI binaries.
 *
 * Which database a call lands in, in precedence order:
 *
 * 1. Dual-DSN mode (`EEMS_DSN_CORE` + `EEMS_DSN_DOUBLE` set): each agent
 *    role gets a store on its own pre-configured DSN. Index and mirror use
 *    the core DSN.
 * 2. Signed-in principal (madcat menubar session → `/api/me` → `db_name`):
 *    the user's instanced database, `{db_name}_{db}` on the base server.
 *    See principal.ts.
 *
 * There is no fallback to the shared base database: without one of the two
 * above, every store/index access throws with a sign-in instruction.
 */

import { MemoryStore, CodeIndex } from "./eems.ts"
import { Embedder } from "./embed.ts"
import { hasDualDsn, dsnForAgent } from "./user-resolver.ts"
import { resolvePrincipal } from "./principal.ts"
import type { ToolContext } from "./identity.ts"

export type { MemoryStore, CodeIndex } from "./eems.ts"

let _embedder: Embedder | null = null
function embedder(): Embedder {
  return (_embedder ??= new Embedder())
}

const stores = new Map<string, MemoryStore>()
const indexes = new Map<string, CodeIndex>()

function storeFor(dsn: string): MemoryStore {
  let s = stores.get(dsn)
  if (!s) {
    s = new MemoryStore(dsn, embedder())
    stores.set(dsn, s)
  }
  return s
}

function indexFor(dsn: string): CodeIndex {
  let i = indexes.get(dsn)
  if (!i) {
    i = new CodeIndex(dsn, embedder())
    indexes.set(dsn, i)
  }
  return i
}

/** DSN for the default (non-agent-scoped) store: dual-DSN core, else the principal's instance. */
async function defaultDsn(): Promise<string> {
  if (hasDualDsn()) return dsnForAgent("core")!
  return (await resolvePrincipal()).dsn
}

/** Default MemoryStore — dual-DSN core, else the signed-in principal's database. */
export async function memoryStore(): Promise<MemoryStore> {
  return storeFor(await defaultDsn())
}

/**
 * MemoryStore for a tool call. In dual-DSN mode `context.agent === "double"`
 * routes to the double DSN; everything else goes to core. Otherwise the
 * principal's instanced database.
 */
export async function memoryStoreForContext(context?: ToolContext): Promise<MemoryStore> {
  if (context && hasDualDsn()) {
    const role = context.agent === "double" ? "double" : "core"
    return storeFor(dsnForAgent(role)!)
  }
  return memoryStore()
}

/** CodeIndex — same database as the default MemoryStore. */
export async function codeIndex(): Promise<CodeIndex> {
  return indexFor(await defaultDsn())
}

/**
 * Warm the connection at plugin init. Never throws — a missing sign-in is
 * reported by whoami_info and by the first memory/index call, not by
 * plugin load.
 */
export async function initNative(): Promise<void> {
  try {
    const store = await memoryStore()
    await store.open()
  } catch (e) {
    console.warn(`[eems] not ready: ${(e as Error).message}`)
  }
}
