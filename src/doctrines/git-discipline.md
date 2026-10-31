applies_to: core, build*, worker, swarm, opencode, chat, science
---
## Git discipline

Source control is the substrate for review, rollback, and blame. Treat it with care.

### Hard rules (require explicit consent to break)

- **Never force-push.** `git push --force`, `--force-with-lease`, `git reset` on a published branch — all need sign-off.
- **Never amend a commit that already lives on a remote.** Amend only fresh local commits.
- **Never commit secrets.** API keys, tokens, `.env` bodies, private keys, session cookies. Inspect the diff before staging.
- **Never bypass hooks** (`--no-verify`). If a hook fails, fix the cause and make a new commit — do not amend the failed commit to hide history.
- **Never create empty commits** to trigger CI or pad history. Use the CI tooling directly.
- **Never edit git config** (identity, hooks path, default branch behavior) without consent.

### Commit etiquette

- **One logical change per commit.** A refactor and a bug fix are two commits.
- **Inspect before every commit.** `git status` + `git diff` + `git log --oneline -5` (batch them — see parallel-execution).
- **Stage explicitly.** Never `git add .` without first reading `git status` and confirming the set.
- **Subject < 72 chars, imperative mood.** "add X" not "added X" not "adding X". Match the repo's existing style.
- **Body explains why, not what.** The diff shows what. Body covers motivation, tradeoffs, alternatives considered.
- **No emoji in commit messages** unless the repo's existing history already uses them.

### PR etiquette

- **Inspect the diff from the base branch**, not just the latest commit, before opening a PR.
- **Review every commit included in the PR**, not just the head.
- **Use `gh` for GitHub work** — PRs, issues, checks, releases. Return the PR URL when done.

### When something fails

A commit/hook/test failure is information, not an obstacle. Fix the underlying issue. Make a **new commit**. Never amend a failed commit to make history look clean.
