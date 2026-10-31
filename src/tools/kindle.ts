/**
 * Kindle tools — deliver curated reading material to Kindle device.
 * Newspaper skill: 3-5 curated articles → EPUB → sent to Kindle via email.
 */

import { tool } from "../lib/tool"
import { execSync, execFileSync } from "child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Resolve skills relative to this module so paths work both in-repo and
// inside the installed npm package (skills/ ships via package.json "files").
const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(__dirname, "..", "..", "skills")

const NEWSPAPER_SH = join(SKILLS_DIR, "newspaper", "newspaper.sh")

/**
 * Execute newspaper.sh — uses execFileSync to avoid shell quoting issues.
 */
function runNewspaper(args: string[], stdin?: string): string {
  try {
    return execFileSync("bash", [NEWSPAPER_SH, ...args], {
      encoding: "utf8",
      stdio: stdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      input: stdin,
    }).trim()
  } catch (e: any) {
    throw new Error(`newspaper.sh failed: ${e.message}\n${e.stderr || ""}`)
  }
}

export const newspaper = tool({
  description:
    "Generate and deliver a Kindle-formatted 'Newspaper' issue — 3-5 curated articles " +
    "(1,500-2,500 words total, 15-25 min read) sent as magazine-style EPUB to the operator's Kindle (MADCAT_KINDLE_EMAIL). " +
    "Issues are sequentially numbered (Newspaper-0001, 0002, ...). Each article gets its own page. " +
    "Curates topics aligned with: AI/HMT, polyvagal/neuroscience, military hardware, fiction craft, " +
    "engineering doctrine, systems thinking, aerospace/mecha, weird science. Excludes work-mode content.",
  args: {
    content: tool.schema
      .string()
      .describe(
        "The full issue as magazine-style markdown — curate 3-5 articles yourself " +
          "(1,500-2,500 words total). Use '# Title' per article so each gets its own page. " +
          "This is piped to the delivery script, numbered, converted to EPUB, and sent.",
      ),
    topic_count: tool.schema
      .number()
      .optional()
      .describe("Informational: number of articles you curated (default: 5, range: 3-7)"),
    issue_type: tool.schema
      .string()
      .optional()
      .describe("Issue flavor label carried into the subject: 'morning' for calmer/contemplative, or omit for generic"),
    dry_run: tool.schema
      .boolean()
      .optional()
      .describe("Preview without sending (counter does not advance)"),
  },
  async execute(args) {
    const shellArgs: string[] = []

    if (args.topic_count) {
      shellArgs.push(String(args.topic_count))
    }

    if (args.issue_type) {
      shellArgs.push(args.issue_type)
    }

    if (args.dry_run) {
      shellArgs.push("--dry")
    }

    // Issue markdown is curated by the caller and piped in via stdin.
    const result = runNewspaper(["send", ...shellArgs], args.content)

    return JSON.stringify({
      success: true,
      message: result,
      note: "Issue sent to the Kindle. Sync typically completes in 1-5 minutes.",
    })
  },
})

export const newspaper_next = tool({
  description: "Peek at the next newspaper issue sequence number without generating an issue.",
  args: {},
  async execute() {
    const result = runNewspaper(["next"])
    return JSON.stringify({ next_sequence: result.trim() })
  },
})

export const newspaper_current = tool({
  description: "Show the last issued newspaper sequence number.",
  args: {},
  async execute() {
    const result = runNewspaper(["current"])
    return JSON.stringify({ current_sequence: result.trim() })
  },
})

const KINDLE_SH = join(SKILLS_DIR, "kindle", "kindle.sh")

/**
 * Execute kindle.sh — uses execFileSync to avoid shell quoting issues with titles.
 */
function runKindle(args: string[], stdin?: string): string {
  try {
    return execFileSync("bash", [KINDLE_SH, ...args], {
      encoding: "utf8",
      stdio: stdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      input: stdin,
    }).trim()
  } catch (e: any) {
    throw new Error(`kindle.sh failed: ${e.message}\n${e.stderr || ""}`)
  }
}

export const send_content = tool({
  description:
    "Send markdown content to Kindle as EPUB. Converts markdown → EPUB → emails to the operator's Kindle (MADCAT_KINDLE_EMAIL). " +
    "Use this when you have detailed information (research results, documentation, long explanations) that's " +
    "too much for a phone screen. The content will be readable on Kindle with proper formatting. " +
    "Sync typically completes in 1-5 minutes. PHONE AGENT: Proactively offer this when you have substantial " +
    "content (>500 words) — ask 'Want this on your Kindle?' before sending.",
  args: {
    title: tool.schema
      .string()
      .describe("Document title (required, shown on Kindle device)"),
    content: tool.schema
      .string()
      .describe("Markdown-formatted content to send. Supports headings, lists, links, emphasis."),
    author: tool.schema
      .string()
      .optional()
      .describe("Author metadata (default: BT-7274)"),
  },
  async execute(args) {
    const shellArgs = ["send-stdin", "--title", args.title]
    
    if (args.author) {
      shellArgs.push("--author", args.author)
    }

    const result = runKindle(shellArgs, args.content)

    return JSON.stringify({
      success: true,
      message: result,
      title: args.title,
      note: "EPUB sent to the Kindle. Sync typically completes in 1-5 minutes.",
    })
  },
})
