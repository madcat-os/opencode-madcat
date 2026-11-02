/**
 * Code screenshot tool — renders syntax-highlighted code to PNG.
 *
 * shiki highlighting → SVG window frame → resvg-wasm raster (src/lib/silicon.ts).
 * No browser, no network, no native binary.
 */

import { tool } from "../lib/tool"
import { writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { render, resolveTheme, DEFAULT_THEME } from "../lib/silicon.ts"

function tmpPng(): string {
  return join(tmpdir(), `code-screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
}

export const screenshot = tool({
  description:
    "Render syntax-highlighted code to a PNG image with terminal window chrome. " +
    "Returns the file path. No browser, no network. 340+ languages (TextMate grammars) and " +
    "any shiki bundled theme (default: github-dark).",
  args: {
    code: tool.schema.string().describe("Source code text to render"),
    language: tool.schema
      .string()
      .describe('Syntax language (e.g. "rust", "typescript", "python", "bash", "text")'),
    theme: tool.schema
      .string()
      .optional()
      .describe(
        "shiki theme. Common: github-dark (default), github-light, one-dark-pro, " +
          "dracula, nord, solarized-dark, solarized-light, dark-plus. " +
          "Old syntect names (base16-ocean.dark, InspiredGitHub, …) are mapped.",
      ),
    title: tool.schema
      .string()
      .optional()
      .describe("Window title text (shown in titlebar)"),
    line_numbers: tool.schema
      .boolean()
      .optional()
      .describe("Show line numbers (default: true)"),
  },
  async execute(args) {
    let png: Buffer
    try {
      png = await render(args.code, args.language, {
        theme: args.theme,
        title: args.title,
        lineNumbers: args.line_numbers,
      })
    } catch (e) {
      return `screenshot error: ${(e as Error).message}`
    }

    const outPath = tmpPng()
    writeFileSync(outPath, png)

    return JSON.stringify({
      path: outPath,
      size_bytes: png.length,
      language: args.language,
      theme: args.theme ? resolveTheme(args.theme) : DEFAULT_THEME,
      lines: args.code.split("\n").length,
    })
  },
})
