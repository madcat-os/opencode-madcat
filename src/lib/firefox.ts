/**
 * Firefox cookie extraction — reads cookies from the local Firefox profile.
 *
 * Handles WAL mode (copies -wal and -shm alongside the main DB) so reads
 * work even while Firefox is running. Uses bun:sqlite for zero-dep access.
 */

import { copyFileSync, existsSync, unlinkSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { Database } from "bun:sqlite"

const PROFILES_DIR = join(homedir(), "Library", "Application Support", "Firefox", "Profiles")
const DEFAULT_PROFILE = "ks3sslng.default-release"

interface CookieRow {
  name: string
  value: string
  host: string
}

/**
 * Read cookies from Firefox's cookie store matching a host pattern.
 *
 * @param hostPattern  SQL LIKE pattern (e.g. `%workatastartup%`)
 * @param profile      Firefox profile directory name (default: default-release)
 * @returns            Array of {name, value, host} or empty array on failure
 */
export function cookies(
  hostPattern: string,
  profile = DEFAULT_PROFILE,
): CookieRow[] {
  const cookieDb = join(PROFILES_DIR, profile, "cookies.sqlite")
  if (!existsSync(cookieDb)) return []

  const tmp = join("/tmp", `ff_cookies_${Date.now()}.sqlite`)
  try {
    // Firefox uses WAL mode — copy all three files for consistent reads.
    copyFileSync(cookieDb, tmp)
    const wal = cookieDb + "-wal"
    const shm = cookieDb + "-shm"
    if (existsSync(wal)) copyFileSync(wal, tmp + "-wal")
    if (existsSync(shm)) copyFileSync(shm, tmp + "-shm")

    const db = new Database(tmp, { readonly: true })
    const rows = db
      .query(`SELECT name, value, host FROM moz_cookies WHERE host LIKE ?`)
      .all(hostPattern) as CookieRow[]
    db.close()
    return rows
  } catch {
    return []
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(tmp + suffix) } catch { /* ignore */ }
    }
  }
}

/**
 * Get a single cookie value by name and host pattern.
 * Returns null if not found.
 */
export function cookie(
  name: string,
  hostPattern: string,
  profile?: string,
): string | null {
  const rows = cookies(hostPattern, profile)
  return rows.find((r) => r.name === name)?.value ?? null
}
