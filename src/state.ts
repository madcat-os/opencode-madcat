import type { Plugin } from "@opencode/plugin"
import type { SupervisorRef, WorkerState } from "./rpc.ts"

type StorageDomain = Plugin.Context["storage"]
type Json = Parameters<StorageDomain["set"]>[1]

export interface WorkerRecord {
  name: string
  directory: string
  supervisor: SupervisorRef
  createdAt: number
}

export interface RosterRecord {
  name: string
  directory: string
  state: WorkerState
  lastSeen: number
}

export interface RosterEntry extends RosterRecord {
  host: string
  sessionID: string
}

const KEY = {
  supervisor: "supervisor",
  workers: "workers/",
  roster: "roster/",
} as const

export class State {
  constructor(private readonly storage: StorageDomain) {}

  private async read<T>(key: string): Promise<T | undefined> {
    return (await this.storage.get(key)) as T | undefined
  }

  private async write(key: string, value: object): Promise<void> {
    await this.storage.set(key, value as Json)
  }

  async supervisor(): Promise<SupervisorRef | undefined> {
    return this.read<SupervisorRef>(KEY.supervisor)
  }

  async setSupervisor(ref: SupervisorRef | undefined): Promise<void> {
    if (ref) await this.write(KEY.supervisor, ref)
    else await this.storage.remove(KEY.supervisor)
  }

  async worker(id: string): Promise<WorkerRecord | undefined> {
    return this.read<WorkerRecord>(KEY.workers + id)
  }

  async setWorker(id: string, record: WorkerRecord): Promise<void> {
    await this.write(KEY.workers + id, record)
  }

  async removeWorker(id: string): Promise<void> {
    await this.storage.remove(KEY.workers + id)
  }

  async workers(): Promise<Array<WorkerRecord & { sessionID: string }>> {
    const { entries } = await this.storage.scan({ prefix: KEY.workers })
    return entries.map((e) => ({ ...(e.value as unknown as WorkerRecord), sessionID: e.key.slice(KEY.workers.length) }))
  }

  async roster(): Promise<RosterEntry[]> {
    const { entries } = await this.storage.scan({ prefix: KEY.roster })
    return entries.flatMap((e) => {
      const [host, sessionID] = e.key.slice(KEY.roster.length).split("/")
      if (!host || !sessionID) return []
      return [{ ...(e.value as unknown as RosterRecord), host, sessionID }]
    })
  }

  async rosterEntry(host: string, id: string): Promise<RosterRecord | undefined> {
    return this.read<RosterRecord>(`${KEY.roster}${host}/${id}`)
  }

  async setRoster(host: string, id: string, record: RosterRecord): Promise<void> {
    await this.write(`${KEY.roster}${host}/${id}`, record)
  }

  async removeRoster(host: string, id: string): Promise<void> {
    await this.storage.remove(`${KEY.roster}${host}/${id}`)
  }
}
