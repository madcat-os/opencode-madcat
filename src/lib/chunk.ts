/**
 * Language-aware chunking with heuristic boundary detection.
 *
 * Port of madcat-memory's chunk.rs — same configs, same boundary detectors,
 * same forward-progress guarantee in split_at_boundaries.
 */

import { detectLanguage, type ChunkType } from "./walk.ts"

export interface RawChunk {
  content: string
  /** 1-indexed */
  lineStart: number
  /** 1-indexed, inclusive */
  lineEnd: number
}

export interface ChunkConfig {
  targetLines: number
  minLines: number
  maxLines: number
  overlap: number
}

export const CODE_CONFIG: ChunkConfig = { targetLines: 120, minLines: 10, maxLines: 300, overlap: 20 }
export const DOCS_CONFIG: ChunkConfig = { targetLines: 150, minLines: 5, maxLines: 400, overlap: 30 }

export function configFor(ct: ChunkType): ChunkConfig {
  return ct === "code" ? CODE_CONFIG : DOCS_CONFIG
}

/** Chunk a file's contents. Boundary-aware for code, paragraph-aware for docs. */
export function chunk(content: string, path: string, ct: ChunkType, config: ChunkConfig): RawChunk[] {
  // Rust `str::lines()` drops a trailing empty line after the final "\n".
  const lines = content.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

  if (lines.length <= config.maxLines) {
    if (lines.length < config.minLines) return []
    return [{ content, lineStart: 1, lineEnd: lines.length }]
  }

  return ct === "code" ? chunkCode(lines, path, config) : chunkDocs(lines, config)
}

function chunkCode(lines: string[], path: string, config: ChunkConfig): RawChunk[] {
  const lang = detectLanguage(path)
  return splitAtBoundaries(lines, findBoundaries(lines, lang), config)
}

function chunkDocs(lines: string[], config: ChunkConfig): RawChunk[] {
  const boundaries: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === "") boundaries.push(i)
    else if (t.startsWith("#")) boundaries.push(i)
    else if (t.length > 3 && /^[=\-~]+$/.test(t)) boundaries.push(i)
  }
  return splitAtBoundaries(lines, boundaries, config)
}

function findBoundaries(lines: string[], lang: string | null): number[] {
  const boundaries: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    if (t === "") {
      boundaries.push(i)
      continue
    }
    let b: boolean
    switch (lang) {
      case "rust": b = isRustBoundary(t); break
      case "typescript": case "tsx": case "javascript": case "jsx": b = isTsBoundary(t); break
      case "python": b = isPythonBoundary(t); break
      case "ruby": b = isRubyBoundary(t); break
      case "go": b = isGoBoundary(t); break
      case "c": case "cpp": b = isCBoundary(t); break
      case "java": case "kotlin": case "csharp": b = isJvmBoundary(t); break
      default: b = isGenericBoundary(line, lines, i)
    }
    if (b) boundaries.push(i)
  }
  return boundaries
}

function splitAtBoundaries(lines: string[], boundaries: number[], config: ChunkConfig): RawChunk[] {
  const total = lines.length
  const chunks: RawChunk[] = []
  let start = 0

  while (start < total) {
    const idealEnd = Math.min(start + config.targetLines, total)
    const hardEnd = Math.min(start + config.maxLines, total)

    if (hardEnd >= total) {
      if (total - start >= config.minLines) {
        chunks.push(makeChunk(lines, start, total))
      } else if (chunks.length > 0) {
        const last = chunks[chunks.length - 1]
        chunks[chunks.length - 1] = makeChunk(lines, last.lineStart - 1, total)
      }
      break
    }

    const best = findBestBoundary(boundaries, idealEnd, start + config.minLines, hardEnd)
    const end = best !== null && best > start ? best : idealEnd

    if (end - start >= config.minLines) {
      chunks.push(makeChunk(lines, start, end))
    }

    // Guarantee forward progress: overlap must never pull start back.
    const next = Math.max(end - config.overlap, 0)
    start = Math.max(next, start + 1)
  }

  return chunks
}

function findBestBoundary(boundaries: number[], target: number, minPos: number, maxPos: number): number | null {
  let best: number | null = null
  let bestDist = Number.MAX_SAFE_INTEGER
  for (const b of boundaries) {
    if (b < minPos || b >= maxPos) continue
    const dist = Math.abs(b - target)
    if (dist < bestDist) {
      bestDist = dist
      best = b
    }
  }
  return best
}

function makeChunk(lines: string[], start: number, end: number): RawChunk {
  return { content: lines.slice(start, end).join("\n"), lineStart: start + 1, lineEnd: end }
}

// ── Language-specific boundary detectors ────────────────────

const starts = (line: string, prefixes: string[]) => prefixes.some((p) => line.startsWith(p))

function isRustBoundary(l: string): boolean {
  return starts(l, ["pub ", "fn ", "pub(", "impl ", "struct ", "enum ", "trait ", "mod ", "use ", "type ", "const ", "static ", "#[cfg", "#[test"])
}

function isTsBoundary(l: string): boolean {
  return starts(l, ["export ", "function ", "class ", "interface ", "type ", "const ", "let ", "import ", "async function", "describe(", "it(", "test("])
}

function isPythonBoundary(l: string): boolean {
  return starts(l, ["def ", "class ", "async def ", "@", "import ", "from ", "if __name__"])
}

function isRubyBoundary(l: string): boolean {
  return l === "end" || starts(l, ["def ", "class ", "module ", "require ", "include ", "describe ", "it ", "context ", "private", "protected"])
}

function isGoBoundary(l: string): boolean {
  return starts(l, ["func ", "type ", "var ", "const ", "package ", "import "])
}

function isCBoundary(l: string): boolean {
  return (
    starts(l, ["#include", "#define", "#ifdef", "#ifndef", "typedef ", "struct ", "enum ", "static ", "extern "]) ||
    (l.endsWith("{") && !l.startsWith(" ") && !l.startsWith("\t"))
  )
}

function isJvmBoundary(l: string): boolean {
  return starts(l, ["public ", "private ", "protected ", "class ", "interface ", "import ", "package ", "@", "fun ", "override "])
}

/** Non-indented non-empty line following an indented line = likely new block. */
function isGenericBoundary(line: string, lines: string[], idx: number): boolean {
  if (idx > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
    const prevRaw = lines[idx - 1]
    const prev = prevRaw.trim()
    if (prev !== "" && (prevRaw.startsWith(" ") || prevRaw.startsWith("\t"))) return true
  }
  return false
}
