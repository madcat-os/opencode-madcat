/**
 * EEMS mirror — writes loaded doctrine bodies into the signed-in principal's
 * EEMS database at subject `doctrine.<slug>` so other consumers (operator-style
 * assistants, the madcat CLI, future agents) can read them via memory_recall.
 *
 * Filesystem remains canonical. This is a one-way fs → EEMS mirror, run once
 * at plugin init. If no principal resolves (not signed in), skip with a
 * reason — we never manufacture databases the operator didn't deploy.
 *
 * Entries are marked with metadata.source = "madcat-plugin" so we can dedupe
 * cleanly against any manually-created `doctrine.*` entries.
 */

import { createHash } from "node:crypto"
import type { Doctrine } from "./doctrines"
import { memoryStore } from "./native.ts"

const SOURCE_TAG = "madcat-plugin"

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

export type MirrorResult = {
  inserted: number
  updated: number
  unchanged: number
  skipped_reason?: string
}

/**
 * Upsert each doctrine into local EEMS. Idempotent — runs cheaply on every
 * plugin init. Never throws; returns a counts summary for diagnostics.
 *
 * MemoryStore.store() dedups by content hash and has no update, so we:
 * 1. Recall existing doctrine entries
 * 2. Compare content hashes
 * 3. Forget + re-store if changed (effectively an update)
 */
export async function mirrorDoctrines(doctrines: Doctrine[]): Promise<MirrorResult> {
  const result: MirrorResult = { inserted: 0, updated: 0, unchanged: 0 }

  let store: Awaited<ReturnType<typeof memoryStore>>
  try {
    store = await memoryStore()
    await store.open()
  } catch (err) {
    result.skipped_reason = `store init failed: ${(err as Error).message}`
    return result
  }

  try {
    for (const d of doctrines) {
      const subject = `doctrine.${d.slug}`
      const hash = sha256(d.content)
      const metadata = JSON.stringify({ source: SOURCE_TAG, slug: d.slug })

      // Check if this doctrine already exists
      const hits = await store.recall({ query: d.slug, subject, limit: 1 })
      const existing = hits.find((h: any) => {
        try {
          const meta = JSON.parse(h.memory?.metadata || "{}")
          return meta.source === SOURCE_TAG && meta.slug === d.slug
        } catch {
          return false
        }
      })

      if (!existing) {
        // New doctrine — insert
        await store.store({
          subject,
          content: d.content,
          classification: "standard",
          confidence: 1.0,
          namespace: "default",
          metadata,
        })
        result.inserted++
      } else {
        // Check if content changed
        const existingHash = existing.memory?.content
          ? sha256(existing.memory.content)
          : ""
        if (existingHash !== hash) {
          // Content changed — forget old, store new
          await store.forget(existing.memory.id)
          await store.store({
            subject,
            content: d.content,
            classification: "standard",
            confidence: 1.0,
            namespace: "default",
            metadata,
          })
          result.updated++
        } else {
          result.unchanged++
        }
      }
    }
  } catch (err) {
    result.skipped_reason = `write failed: ${(err as Error).message}`
  }

  return result
}
