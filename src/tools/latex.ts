/**
 * LaTeX PDF rendering tool — renders LaTeX source to PDF via tectonic.
 *
 * Tectonic is a self-contained LaTeX engine (Rust, no TeX Live dependency).
 * Downloads packages on demand, caches them locally.
 */

import { tool } from "../lib/tool"
import { writeFileSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { execSync } from "child_process"

const TECTONIC = process.env.TECTONIC_PATH ?? "tectonic"

function tmpTex(): string {
  return join(tmpdir(), `latex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

export const render = tool({
  description:
    "Render LaTeX source to PDF via tectonic. Returns the file path of the generated PDF. " +
    "Tectonic is a self-contained LaTeX engine — supports full LaTeX including packages, math, tables, " +
    "TikZ, etc. Packages are downloaded automatically on first use.",
  args: {
    source: tool.schema
      .string()
      .describe(
        "LaTeX source code. Must be a complete document (with \\documentclass, \\begin{document}, etc.) " +
          "or a fragment (will be wrapped in a minimal article document automatically).",
      ),
    filename: tool.schema
      .string()
      .optional()
      .describe("Output filename (without .pdf extension). Default: 'document'"),
  },
  async execute(args) {
    let source = args.source

    // Auto-wrap fragments in a minimal document
    if (!source.includes("\\documentclass")) {
      source = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb}
\\usepackage{geometry}
\\geometry{margin=1in}
\\begin{document}
${source}
\\end{document}`
    }

    const base = tmpTex()
    const texPath = `${base}.tex`
    const outDir = tmpdir()
    const pdfName = args.filename ?? "document"
    const pdfPath = join(outDir, `${pdfName}.pdf`)

    writeFileSync(texPath, source, "utf-8")

    try {
      const result = execSync(
        `${TECTONIC} "${texPath}" -o "${outDir}" 2>&1`,
        { encoding: "utf-8", timeout: 60_000 },
      )

      // Tectonic outputs to <basename>.pdf in the output dir
      const tectOutPath = join(outDir, `${texPath.split("/").pop()!.replace(".tex", ".pdf")}`)

      // Rename to desired filename if different
      if (tectOutPath !== pdfPath) {
        try {
          execSync(`mv "${tectOutPath}" "${pdfPath}"`)
        } catch {
          // If rename fails, use tectonic's output path
          return JSON.stringify({
            path: tectOutPath,
            size_bytes: require("fs").statSync(tectOutPath).size,
            filename: tectOutPath.split("/").pop(),
          })
        }
      }

      return JSON.stringify({
        path: pdfPath,
        size_bytes: require("fs").statSync(pdfPath).size,
        filename: `${pdfName}.pdf`,
      })
    } catch (e: any) {
      const stderr = e?.stderr?.toString?.() || e?.stdout?.toString?.() || e?.message || ""
      throw new Error(`LaTeX render failed: ${stderr.slice(0, 500)}`)
    } finally {
      try { unlinkSync(texPath) } catch {}
    }
  },
})
