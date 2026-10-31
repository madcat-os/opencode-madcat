/**
 * user-resolver — per-user EEMS DSN resolution.
 *
 * When EEMS_DSN_CORE and EEMS_DSN_DOUBLE are set, memory tools route to
 * schema-isolated stores based on context.agent. Each unix user's opencode
 * instance sets these in its environment — no DB lookup needed.
 *
 * When neither is set, falls back to the default singleton store (EEMS_PG_DSN).
 */

/** True when per-agent DSNs are configured. */
export function hasDualDsn(): boolean {
  return !!(process.env.EEMS_DSN_CORE && process.env.EEMS_DSN_DOUBLE)
}

/** Get the DSN for a given agent role. Returns null if dual DSN not configured. */
export function dsnForAgent(agent: string): string | null {
  if (!hasDualDsn()) return null
  return agent === "double"
    ? process.env.EEMS_DSN_DOUBLE!
    : process.env.EEMS_DSN_CORE!
}
