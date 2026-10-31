/**
 * Embedding client — remote Ollama (`/api/embed`) or OpenAI-compatible
 * (`/v1/embeddings`) endpoint, read from `[embedding]` in config.toml.
 *
 * Port of madcat-memory's embed.rs. Async; batches of EMBED_BATCH texts.
 */

import { embeddingConfig, type EmbeddingConfig } from "./config.ts"

export const EMBED_BATCH = 64

export class Embedder {
  readonly cfg: EmbeddingConfig

  constructor(cfg: EmbeddingConfig = embeddingConfig()) {
    this.cfg = cfg
  }

  get modelId(): string {
    return this.cfg.model
  }

  get dimensions(): number {
    return this.cfg.dimensions
  }

  /** Embed a batch of texts. Splits into EMBED_BATCH-sized requests. */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH)
      const vecs = this.cfg.provider === "openai" ? await this.openai(batch) : await this.ollama(batch)
      if (vecs.length !== batch.length) {
        throw new Error(`embedding: expected ${batch.length} vectors, got ${vecs.length}`)
      }
      out.push(...vecs)
    }
    return out
  }

  /** Embed one text. */
  async embedOne(text: string): Promise<number[]> {
    const [v] = await this.embed([text])
    return v
  }

  private async ollama(input: string[]): Promise<number[][]> {
    const res = await fetch(`${this.cfg.url}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.cfg.model, input, keep_alive: -1 }),
    }).catch((e) => {
      throw new Error(`embedding: ollama request failed: ${(e as Error).message}`)
    })
    if (!res.ok) throw new Error(`embedding: ollama ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { embeddings?: number[][] }
    if (!body.embeddings) throw new Error("embedding: ollama response had no embeddings")
    return body.embeddings
  }

  private async openai(input: string[]): Promise<number[][]> {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`
    const res = await fetch(`${this.cfg.url}/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.cfg.model, input }),
    }).catch((e) => {
      throw new Error(`embedding: openai embed request failed: ${(e as Error).message}`)
    })
    if (!res.ok) throw new Error(`embedding: openai ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { data?: { index?: number; embedding: number[] }[] }
    if (!body.data) throw new Error("embedding: openai response had no data")
    // Preserve request order — some servers return out of order with index.
    const sorted = body.data.every((d) => typeof d.index === "number")
      ? [...body.data].sort((a, b) => a.index! - b.index!)
      : body.data
    return sorted.map((d) => d.embedding)
  }
}

/** pgvector text literal: `[0.1,0.2,...]`. Bind as `${vec(v)}::vector`. */
export function vectorLiteral(v: number[]): string {
  return "[" + v.join(",") + "]"
}
