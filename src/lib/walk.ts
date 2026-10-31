/**
 * Gitignore-aware file walker for the code/docs indexer.
 *
 * Port of madcat-memory's walk.rs. Inside a git work tree we ask git for the
 * file list (`ls-files --cached --others --exclude-standard`) which honours
 * .gitignore, global excludes and .git/info/exclude the same way the Rust
 * `ignore` crate did. Outside git: recursive readdir, hidden entries skipped.
 * Either way SKIP_DIRS and the extension filter apply on top.
 */

import { readdirSync, statSync } from "node:fs"
import { basename, extname, join, relative, sep } from "node:path"

export type ChunkType = "code" | "docs"

const CODE_EXTS = new Set([
  "rs", "ts", "tsx", "js", "jsx", "py", "rb", "go", "c", "cpp", "cc", "h", "hpp",
  "java", "kt", "swift", "cs", "lua", "zig", "asm", "s", "sh", "bash", "zsh",
  "fish", "ps1", "bat", "cmd", "sql", "toml", "yaml", "yml", "json", "jsonc",
  "xml", "html", "css", "scss", "sass", "less", "svelte", "vue", "kdl", "nix",
  "tf", "hcl", "proto", "graphql", "gql", "wasm", "wat", "makefile", "cmake",
  "dockerfile", "containerfile", "just", "mjs", "cjs", "mts", "cts",
])

const DOC_EXTS = new Set(["md", "mdx", "txt", "rst", "adoc", "org", "tex"])

const SKIP_DIRS = new Set([
  "node_modules", ".git", "target", "dist", "build", "__pycache__",
  ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
  ".next", ".nuxt", ".output", ".turbo", ".cache",
  "vendor",
])

const CODE_NAMES = new Set(["makefile", "dockerfile", "containerfile", "justfile", "rakefile", "gemfile", "cmakelists.txt"])
const DOC_NAMES = new Set(["readme", "changelog", "license", "contributing", "authors", "todo", "notes"])

const MAX_DEPTH = 20

function extOf(path: string): string {
  const e = extname(path)
  return e ? e.slice(1).toLowerCase() : ""
}

function matches(relPath: string, ct: ChunkType): boolean {
  // Any ancestor in SKIP_DIRS?
  const parts = relPath.split(sep)
  for (let i = 0; i < parts.length - 1; i++) if (SKIP_DIRS.has(parts[i])) return false
  // Hidden files/dirs are skipped (the Rust walker used .hidden(true)).
  if (parts.some((p) => p.startsWith(".") && p !== "." && p !== "..")) return false

  const ext = extOf(relPath)
  if (ext) return (ct === "code" ? CODE_EXTS : DOC_EXTS).has(ext)
  const lower = basename(relPath).toLowerCase()
  return ct === "code" ? CODE_NAMES.has(lower) : DOC_NAMES.has(lower)
}

function gitFiles(root: string): string[] | null {
  try {
    const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: root, stdout: "pipe", stderr: "ignore" })
    if (top.exitCode !== 0) return null
    const ls = Bun.spawnSync(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
      { cwd: root, stdout: "pipe", stderr: "ignore" },
    )
    if (ls.exitCode !== 0) return null
    return ls.stdout.toString().split("\0").filter((s) => s.length > 0)
  } catch {
    return null
  }
}

function readdirFiles(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        visit(full, depth + 1)
      } else if (ent.isFile()) {
        out.push(relative(root, full))
      }
    }
  }
  visit(root, 0)
  return out
}

/**
 * Walk `root`, returning paths relative to `root` that match the chunk type.
 * Only regular files; symlinks are not followed.
 */
export function walk(root: string, ct: ChunkType): string[] {
  const candidates = gitFiles(root) ?? readdirFiles(root)
  const files: string[] = []
  for (const rel of candidates) {
    if (!matches(rel, ct)) continue
    try {
      // lstat-free check: statSync follows links; reject anything not a regular file.
      if (!statSync(join(root, rel)).isFile()) continue
    } catch {
      continue
    }
    files.push(rel)
  }
  files.sort()
  return files
}

/** Detect language from file extension. */
export function detectLanguage(path: string): string | null {
  switch (extOf(path)) {
    case "rs": return "rust"
    case "ts": case "mts": case "cts": return "typescript"
    case "tsx": return "tsx"
    case "js": case "mjs": case "cjs": return "javascript"
    case "jsx": return "jsx"
    case "py": return "python"
    case "rb": return "ruby"
    case "go": return "go"
    case "c": case "h": return "c"
    case "cpp": case "cc": case "hpp": return "cpp"
    case "java": return "java"
    case "kt": return "kotlin"
    case "swift": return "swift"
    case "cs": return "csharp"
    case "lua": return "lua"
    case "zig": return "zig"
    case "sh": case "bash": case "zsh": case "fish": return "shell"
    case "sql": return "sql"
    case "toml": return "toml"
    case "yaml": case "yml": return "yaml"
    case "json": case "jsonc": return "json"
    case "xml": case "html": return "html"
    case "css": case "scss": case "sass": case "less": return "css"
    case "svelte": return "svelte"
    case "vue": return "vue"
    case "kdl": return "kdl"
    case "nix": return "nix"
    case "tf": case "hcl": return "hcl"
    case "proto": return "protobuf"
    case "graphql": case "gql": return "graphql"
    case "md": case "mdx": return "markdown"
    case "txt": case "rst": case "adoc": case "org": case "tex": return "text"
    default: return null
  }
}
