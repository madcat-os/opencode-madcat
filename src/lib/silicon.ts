/**
 * silicon — syntax-highlighted code → PNG with terminal window chrome.
 *
 * Replaces the madcat-silicon NAPI module (syntect + image). Highlighting is
 * shiki (TextMate grammars, VS Code themes); the frame is built as SVG and
 * rasterised by resvg-wasm with Hack Regular from src/assets. No browser, no
 * network, no native binary; first call pays ~200ms of grammar/wasm init.
 *
 * Geometry matches the Rust renderer: 26px monospace on a 32px line, 40px
 * titlebar with macOS traffic lights, rounded window on a 20px dark mat.
 */

import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { createHighlighter, bundledLanguages, bundledThemes, type Highlighter, type ThemedToken } from "shiki"
import { Resvg, initWasm } from "@resvg/resvg-wasm"

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const FONT_PATH = join(__dirname, "..", "assets", "Hack-Regular.ttf")
const WASM_PATH = require.resolve("@resvg/resvg-wasm/index_bg.wasm")

export interface RenderOptions {
  /** shiki theme name (default: github-dark). Legacy syntect names are mapped. */
  theme?: string
  /** Show line numbers (default: true). */
  lineNumbers?: boolean
  /** Show macOS traffic lights (default: true). */
  windowControls?: boolean
  /** Titlebar text. */
  title?: string
  /** Window background `#RRGGBB` (default: theme background). */
  background?: string
}

export const DEFAULT_THEME = "github-dark"

/** Old syntect theme names → closest shiki bundled theme. */
const LEGACY_THEMES: Record<string, string> = {
  "base16-ocean.dark": "github-dark",
  "base16-ocean.light": "github-light",
  "base16-eighties.dark": "one-dark-pro",
  "base16-mocha.dark": "dracula",
  "InspiredGitHub": "github-light",
  "Solarized (dark)": "solarized-dark",
  "Solarized (light)": "solarized-light",
}

const LANG_ALIASES: Record<string, string> = {
  text: "text",
  plaintext: "text",
  txt: "text",
  plain: "text",
  sh: "shellscript",
  zsh: "shellscript",
  bash: "bash",
  js: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  yml: "yaml",
  md: "markdown",
}

// Layout constants (px) — identical to the Rust module.
const FONT_SIZE = 26
const LINE_HEIGHT = 32
const CHAR_WIDTH = 16
const PADDING_X = 32
const PADDING_Y = 24
const TITLEBAR_HEIGHT = 40
const CORNER_RADIUS = 10
const LINE_NUMBER_WIDTH = 50
const OUTER_PADDING = 20
const MAT_COLOR = "#1e1e1e"
const TITLE_COLOR = "#b4b4b4"
const LINE_NUMBER_COLOR = "#646e78"

// ── Lazy singletons ─────────────────────────────────────────

let _highlighter: Promise<Highlighter> | null = null
let _wasm: Promise<void> | null = null
let _font: Uint8Array | null = null

function highlighter(): Promise<Highlighter> {
  return (_highlighter ??= createHighlighter({ themes: [DEFAULT_THEME], langs: [] }))
}

function wasm(): Promise<void> {
  return (_wasm ??= initWasm(readFileSync(WASM_PATH)).catch((e) => {
    _wasm = null
    throw new Error(`silicon: resvg wasm init failed: ${(e as Error).message}`)
  }))
}

function font(): Uint8Array {
  return (_font ??= new Uint8Array(readFileSync(FONT_PATH)))
}

/** Warm grammars/wasm at plugin init. Never throws. */
export async function initSilicon(): Promise<void> {
  try {
    await Promise.all([highlighter(), wasm()])
  } catch (e) {
    console.warn(`[silicon] not ready: ${(e as Error).message}`)
  }
}

// ── Helpers ─────────────────────────────────────────────────

export function resolveTheme(name?: string): string {
  if (!name) return DEFAULT_THEME
  const mapped = LEGACY_THEMES[name] ?? name
  if (!(mapped in bundledThemes)) {
    throw new Error(`silicon: unknown theme '${name}'. available: ${Object.keys(bundledThemes).join(", ")}`)
  }
  return mapped
}

export function resolveLanguage(name: string): string {
  const l = LANG_ALIASES[name.toLowerCase()] ?? name.toLowerCase()
  return l === "text" || l in bundledLanguages ? l : "text"
}

export function listThemes(): string[] {
  return Object.keys(bundledThemes)
}

export function listLanguages(): string[] {
  return Object.keys(bundledLanguages)
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function hexColor(c: string | undefined, fallback: string): string {
  if (!c) return fallback
  const h = c.trim()
  return /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(h) ? h : fallback
}

function darken(hex: string, by: number): string {
  const n = parseInt(hex.slice(1, 7), 16)
  const r = Math.max(0, (n >> 16) - by)
  const g = Math.max(0, ((n >> 8) & 0xff) - by)
  const b = Math.max(0, (n & 0xff) - by)
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")
}

/** Visual width in cells; tabs expand to 4. */
function cells(s: string): number {
  return [...s.replace(/\t/g, "    ")].length
}

// ── Render ──────────────────────────────────────────────────

/** Render `code` to PNG bytes. */
export async function render(code: string, language: string, opts: RenderOptions = {}): Promise<Buffer> {
  const theme = resolveTheme(opts.theme)
  const lang = resolveLanguage(language)
  const showLineNumbers = opts.lineNumbers ?? true
  const showControls = opts.windowControls ?? true

  const [hl] = await Promise.all([highlighter(), wasm()])
  if (!hl.getLoadedThemes().includes(theme)) await hl.loadTheme(theme as any)
  if (lang !== "text" && !hl.getLoadedLanguages().includes(lang)) await hl.loadLanguage(lang as any)

  // Rust `str::lines()` semantics: drop the trailing empty line after a final "\n".
  const src = code.endsWith("\n") ? code.slice(0, -1) : code
  const lines: ThemedToken[][] =
    lang === "text"
      ? src.split("\n").map((l) => [{ content: l, offset: 0 } as ThemedToken])
      : hl.codeToTokensBase(src, { lang: lang as any, theme: theme as any })

  const themeBg = hl.getTheme(theme as any).bg ?? "#2b303b"
  const bg = hexColor(opts.background, themeBg)
  const titlebarBg = darken(bg, 10)

  const maxLen = Math.max(0, ...lines.map((toks) => cells(toks.map((t) => t.content).join(""))))
  const numLines = Math.max(1, lines.length)
  const lineNumOffset = showLineNumbers ? LINE_NUMBER_WIDTH : 0
  const contentWidth = maxLen * CHAR_WIDTH + lineNumOffset
  const contentHeight = numLines * LINE_HEIGHT
  const imgWidth = contentWidth + PADDING_X * 2
  const imgHeight = contentHeight + PADDING_Y * 2 + TITLEBAR_HEIGHT
  const totalWidth = imgWidth + OUTER_PADDING * 2
  const totalHeight = imgHeight + OUTER_PADDING * 2

  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}">`,
    `<rect width="${totalWidth}" height="${totalHeight}" fill="${MAT_COLOR}"/>`,
    `<clipPath id="win"><rect x="${OUTER_PADDING}" y="${OUTER_PADDING}" width="${imgWidth}" height="${imgHeight}" rx="${CORNER_RADIUS}"/></clipPath>`,
    `<g clip-path="url(#win)">`,
    `<rect x="${OUTER_PADDING}" y="${OUTER_PADDING}" width="${imgWidth}" height="${imgHeight}" fill="${bg}"/>`,
    `<rect x="${OUTER_PADDING}" y="${OUTER_PADDING}" width="${imgWidth}" height="${TITLEBAR_HEIGHT}" fill="${titlebarBg}"/>`,
  )

  if (showControls) {
    const cy = OUTER_PADDING + TITLEBAR_HEIGHT / 2
    const x0 = OUTER_PADDING + 20
    for (const [i, c] of ["#ff5f57", "#ffbd2e", "#27c93f"].entries()) {
      parts.push(`<circle cx="${x0 + i * 22}" cy="${cy}" r="7" fill="${c}"/>`)
    }
  }

  if (opts.title) {
    parts.push(
      `<text x="${OUTER_PADDING + imgWidth / 2}" y="${OUTER_PADDING + TITLEBAR_HEIGHT / 2}" ` +
        `font-family="Hack" font-size="16" fill="${TITLE_COLOR}" text-anchor="middle" dominant-baseline="central">${esc(opts.title)}</text>`,
    )
  }

  const codeX = OUTER_PADDING + PADDING_X
  const codeY = OUTER_PADDING + TITLEBAR_HEIGHT + PADDING_Y
  parts.push(`<g font-family="Hack" font-size="${FONT_SIZE}" xml:space="preserve">`)

  for (let i = 0; i < lines.length; i++) {
    // Baseline sits at ~0.78 of the line box for Hack's ascent at this size.
    const y = codeY + i * LINE_HEIGHT + Math.round(LINE_HEIGHT * 0.78)
    if (showLineNumbers) {
      parts.push(`<text x="${codeX}" y="${y}" fill="${LINE_NUMBER_COLOR}">${String(i + 1).padStart(3)}</text>`)
    }
    let x = codeX + lineNumOffset
    for (const tok of lines[i]) {
      const text = tok.content.replace(/\t/g, "    ")
      if (text.length === 0) continue
      const fill = tok.color ?? "#c0c5ce"
      parts.push(`<text x="${x}" y="${y}" fill="${fill}">${esc(text)}</text>`)
      x += cells(text) * CHAR_WIDTH
    }
  }

  parts.push(`</g></g></svg>`)

  const resvg = new Resvg(parts.join(""), {
    font: { fontBuffers: [font()], defaultFontFamily: "Hack", loadSystemFonts: false },
    fitTo: { mode: "original" },
  })
  const png = resvg.render().asPng()
  return Buffer.from(png)
}
