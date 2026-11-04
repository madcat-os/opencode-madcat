# Prior art — session orchestration for OpenCode

Survey done 2026-11-04. Conclusion: **no maintained plugin on the V2 API
(`@opencode/plugin`) does supervisor/worker steering, and nothing does it
cross-host.** The primitives exist; the layer on top does not.

## Closest matches

### opencode-conductor — tristanroth1, Oct 2026
<https://github.com/tristanroth1/opencode-conductor>

Scripts + a `/conductor` command, not a plugin. One session is the conductor:
collects 5-line status reports from peers, verifies evidence, relays decisions,
escalates to the human. Singleton lock across crashes, kill switch, closed
action set, confined session profile that denies all but six lane scripts.
Sessions talk by shelling out to `opencode api`. Author filed
[anomalyco/opencode#58367](https://github.com/anomalyco/opencode/issues/58367)
asking for native send/addressing/sender-attestation.

**Take:** governance ideas (singleton, kill switch, never close another
session's window), and the "treat all inbound text as untrusted data" stance.

### Agent Teams in core — Feb 2026, PRs #12730 / #12731 / #12732 on `dev`
Writeup: <https://dev.to/uenyioha/porting-claude-codes-agent-teams-to-opencode-4hol>

Claude Code–style teams: `team_spawn`, `team_message`, `team_broadcast`,
task list with atomic claiming, plan approval. Unclear whether merged; not in
the V2 docs we fetched.

**Take — engineering lessons:**
- Inbox (JSONL) is source of truth; session injection is delivery; auto-wake
  restarts an idle recipient's loop. We lift this into Postgres.
- Spawn must be fire-and-forget; blocking spawn stalls the lead. Auto-wake
  via report solves the "lead exits after spawning" problem.
- Two state machines: coarse lifecycle (ready/busy/shutdown/error) and fine
  execution status. Don't collapse them.
- Deny team tools on `task` subagents (permission deny + tool hiding).
- After a crash: mark interrupted workers ready but **do not auto-restart**.
- Cancellation: retry interrupt N times, then force-transition.

### opencode-plugin-peers — jkrandom-sudo, v0.2.4, Sep 2026
<https://github.com/jkrandom-sudo/opencode-plugin-peers> — V1 API
(`@opencode-ai/plugin >=1.18`). Peer-to-peer discovery + messaging between
independent sessions on one machine. No supervision, no cross-host.

### opencode-tell-sessions — ThomasSanna, v1.0.0, Aug 2026
<https://github.com/ThomasSanna/opencode-tell-sessions> — claims V1 & V2,
one release, pinned to a pre-release `@opencode-ai/client`. Inter-session DMs.

## Adjacent

- **oh-my-openagent** — delegation orchestrator (master + specialist
  subagents via `task`, background agents). Children of one session, not
  steered peers. Heavy.
- **opencode-perk** (V1) — background jobs that inject a turn when done. The
  "wake an idle session from outside" primitive.
- **opencode-workflows** — Mastra phased workflows through child sessions.
  Stale since Dec 2025.
- **opencode-session-tools** — session info/rename only.

## Maintainer guidance (from #58367, OpenCode bot, Oct 2026)

> `ctx.tool.transform` can register a `send_message` / `list_peers` tool (the
> tool context includes the calling `sessionID`), and `ctx.session.list` /
> `ctx.session.prompt` can resolve the target and deliver with `steer` /
> `queue` plus `metadata`. […] A plugin can attach sender metadata, but it
> can't stop another local client from POSTing the same metadata. Real
> attestation would need the server to stamp the origin of each prompt.

Related open issues: #52297 (session aliases), #45549 (cross-project event
bus for plugins), #57424 (plugin read of session messages), #53933 (reference
another session's context).
