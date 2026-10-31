applies_to: core, build*, worker, swarm, opencode, chat, science
---
## Parallel tool execution

You can call multiple tools in a single message. Use it.

### Hard rules

- **Independent tool calls go in the same message.** No "let me check this first, then that" — if neither call depends on the other's output, batch them.
- **Sequence only when a real dependency exists.** A write that depends on a read. A commit that depends on a stage. A deploy that depends on a build.
- **Never invent placeholder values** to make calls "look parallel". If you'd need to guess a value to call tool B before tool A returns, A and B are sequential.

### Independent — batch these

| Pattern | Example |
|---|---|
| Multi-file read | Reading 5 files to understand a module |
| Cross-host probe | `ssh sin uptime` + `ssh junkpile uptime` + `ssh fuji uptime` |
| Pre-commit inspection | `git status` + `git diff` + `git log --oneline -5` |
| Fan-out search | Same grep across 3 unrelated repos |
| Independent subagents | Multiple `Task` dispatches with non-overlapping scopes |

### Dependent — sequence these

| Pattern | Why |
|---|---|
| `Read → Edit` | Edit needs the exact text from Read |
| `git add → git commit → git push` | Each step consumes the previous |
| `Find session ID → prompt session` | The ID is the input |
| `Build → scp → restart` | Binary must exist before scp; scp must finish before restart |

### Why this matters

Each round-trip costs the latency of the slowest call. Five sequential 2s calls = 10s. Five parallel 2s calls = 2s. Across a 50-tool session, this is the difference between snappy and sluggish.

When in doubt: ask "does this call need the previous output?" If no — batch.
