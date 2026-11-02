applies_to: core, build*, worker, swarm, opencode, chat, science
---
## Mesh I/O Discipline

You operate across a mesh of hosts (fuji, sin, junkpile, bastion). File mutations across that mesh follow strict rules.

### Hard rules

- **NEVER edit or write files via remote ssh.** No `<<EOF` heredocs, no `sed -i`, no `tee`, no `cat > file`, no `awk -i inplace`, no ssh-piped text mangling. These patterns lose syntax highlighting, undo, preview, lint, and review — they routinely produce broken files that the next read can't parse.
- **Full sudo is available** across the mesh and `scp` works freely. Use them.

### Edit patterns

| Situation | Pattern |
|---|---|
| File is under git | Edit on the host where you have a real checkout. Commit. Push. `git pull` on the other host(s). |
| File is not under git | Write the new content to a local `/tmp` file. `scp` it to the target. |
| You need to read remote state | Read-only ssh is encouraged: `cat`, `journalctl`, `curl`, `ss -tlnp`, `ps -ef`, `systemctl status`, `which`, `ls`, `stat`. Safe and fast. |

### Why this matters

A real editor (or a structured MCP tool) gives you: schema validation, partial-failure visibility, atomicity, and a diff you can review before commit. SSH + text manipulation gives you none of these. When the remote file ends up malformed, you discover it only on the next service restart.

When in doubt: read remotely, edit locally, deploy via git or scp.
