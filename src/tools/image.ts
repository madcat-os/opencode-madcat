/**
 * Image generation tool — text-to-image via the tensors API (ComfyUI gateway).
 *
 * Calls POST /api/comfyui/generate on the tensors host (config.toml [tensors]),
 * polls for the result, and downloads the PNG to local /tmp. Runs on the GPU
 * via ComfyUI — no model loading in-process, so it coexists with TTS.
 *
 * Use with signal_send(attachment=path) to share generated images.
 */

import { tool } from "../lib/tool"
import { writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { tensorsUrl } from "../lib/config.ts"

const TENSORS = tensorsUrl()

interface GenerateResponse {
  success: boolean
  prompt_id: string
  images: string[]
  errors?: Record<string, unknown>
}

function tmpPng(): string {
  return join(tmpdir(), `image-gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
}

export const generate = tool({
  description:
    "Generate an image from a text prompt via Stable Diffusion (ComfyUI on the GPU). " +
    "Returns the local file path of the rendered PNG. Use with signal_send(attachment=path) " +
    "to share. Runs on RTX 2000 Ada — SDXL and SD1.5 checkpoints available. " +
    "Coexists with TTS (no in-process model loading). " +
    "List models with image_models.",
  args: {
    prompt: tool.schema.string().describe("Positive prompt — what to generate"),
    negative_prompt: tool.schema
      .string()
      .optional()
      .describe("Negative prompt — what to avoid (default: empty)"),
    model: tool.schema
      .string()
      .optional()
      .describe(
        'Checkpoint filename (e.g. "SDXL/sd_xl_base_1.0.safetensors", ' +
          '"SDXL-TURBO/sd_xl_turbo_1.0_fp16.safetensors"). Use image_models to list. ' +
          "Default: server default.",
      ),
    width: tool.schema
      .number()
      .int()
      .min(64)
      .max(4096)
      .optional()
      .describe("Image width in pixels (default: 1024)"),
    height: tool.schema
      .number()
      .int()
      .min(64)
      .max(4096)
      .optional()
      .describe("Image height in pixels (default: 1024)"),
    steps: tool.schema
      .number()
      .int()
      .min(1)
      .max(150)
      .optional()
      .describe("Sampling steps (default: 20). Turbo models: 4-8. Standard SDXL: 20-40."),
    cfg: tool.schema
      .number()
      .min(1)
      .max(30)
      .optional()
      .describe("CFG scale — prompt adherence (default: 7). Turbo models: 1-2."),
    seed: tool.schema
      .number()
      .int()
      .optional()
      .describe("Random seed (-1 for random, default: -1). Use a fixed seed to reproduce."),
    sampler: tool.schema
      .string()
      .optional()
      .describe(
        "Sampler name (default: euler). Common: euler, euler_ancestral, dpmpp_2m, " +
          "dpmpp_2m_sde, dpmpp_3m_sde, ddim, uni_pc, lcm.",
      ),
    scheduler: tool.schema
      .string()
      .optional()
      .describe(
        "Scheduler (default: normal). Options: normal, karras, exponential, " +
          "sgm_uniform, simple, beta, ddim_uniform, kl_optimal.",
      ),
    vae: tool.schema
      .string()
      .optional()
      .describe("VAE model filename (default: server default / baked-in VAE)"),
    lora_name: tool.schema
      .string()
      .optional()
      .describe("LoRA filename to apply (optional). Use image_models to list."),
    lora_strength: tool.schema
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe("LoRA strength (default: 0.8). Only used when lora_name is set."),
  },
  async execute(args) {
    const body: Record<string, unknown> = { prompt: args.prompt }
    if (args.negative_prompt !== undefined) body.negative_prompt = args.negative_prompt
    if (args.model !== undefined) body.model = args.model
    if (args.width !== undefined) body.width = args.width
    if (args.height !== undefined) body.height = args.height
    if (args.steps !== undefined) body.steps = args.steps
    if (args.cfg !== undefined) body.cfg = args.cfg
    if (args.seed !== undefined) body.seed = args.seed
    if (args.sampler !== undefined) body.sampler = args.sampler
    if (args.scheduler !== undefined) body.scheduler = args.scheduler
    if (args.vae !== undefined) body.vae = args.vae
    if (args.lora_name !== undefined) body.lora_name = args.lora_name
    if (args.lora_strength !== undefined) body.lora_strength = args.lora_strength

    // Generate (blocks server-side until ComfyUI finishes the prompt)
    const res = await fetch(`${TENSORS}/api/comfyui/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`tensors generate failed: HTTP ${res.status} ${text}`)
    }

    const result = (await res.json()) as GenerateResponse
    if (!result.success || !result.images?.length) {
      throw new Error(`generation failed: ${JSON.stringify(result.errors || result)}`)
    }

    const filename = result.images[0]

    // Download the rendered image
    const imgRes = await fetch(`${TENSORS}/api/comfyui/image/${encodeURIComponent(filename)}`)
    if (!imgRes.ok) {
      throw new Error(`image download failed: HTTP ${imgRes.status} for ${filename}`)
    }
    const buf = Buffer.from(await imgRes.arrayBuffer())

    const outPath = tmpPng()
    writeFileSync(outPath, buf)

    return JSON.stringify({
      path: outPath,
      size_bytes: buf.length,
      prompt_id: result.prompt_id,
      filename,
      model: args.model || "server default",
      width: args.width ?? 1024,
      height: args.height ?? 1024,
      steps: args.steps ?? 20,
      seed: args.seed ?? -1,
    })
  },
})

export const models = tool({
  description:
    "List available image generation models — checkpoints, LoRAs, VAEs — on the tensors " +
    "ComfyUI server. Use the returned filenames as the 'model' or 'lora_name' arg to " +
    "image_generate.",
  args: {},
  async execute() {
    const res = await fetch(`${TENSORS}/api/comfyui/models`)
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`tensors models failed: HTTP ${res.status} ${text}`)
    }
    const data = (await res.json()) as Record<string, string[]>
    return JSON.stringify(data, null, 2)
  },
})
