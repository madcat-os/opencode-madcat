applies_to: core, build*, worker, swarm, opencode, chat, science
---
## Tool selection

For every operation there is a right tool. Use it.

### File operations

| Need | Use | Not |
|---|---|---|
| Read a file | `Read` | `bash cat / head / tail` |
| Edit a file | `Edit` | `bash sed / awk -i` |
| Create a file | `Write` | `bash echo > / cat <<EOF` |
| Find files by name | `Glob` | `bash find / ls -R` |
| Search file contents | `Grep` | `bash grep` (use `rg` only when you need counts or streaming) |
| Edit a JSON config | `json_set` / `json_merge` / `json_del` | text-editing the JSON |

Dedicated tools give you: schema awareness, atomicity, diff preview, undo, syntax validation, structured errors. Bash text manipulation gives you none of these and routinely produces broken files.

### Communication

- **Output text directly.** Never use `bash echo` / `printf` to "communicate" with the operator.
- **No code comments as messages.** Comments are for code readers, not the conversation.
- **No tool calls as side channels.** Don't `tui_toast` or write a temp file to make a point — say it in your response.

### Bash is for system commands

Reserve `Bash` for:

- Service management: `systemctl`, `launchctl`, `brew services`
- Git operations: `git status`, `git commit`, `git push`, `gh ...`
- Build tooling: `npm`, `bun`, `cargo`, `make`, `just`
- Process inspection: `ps`, `lsof`, `ss`, `top`
- Package management: `brew`, `apt`, `pacman`
- Read-only remote inspection: `ssh host 'cat /etc/foo'`, `journalctl`, `systemctl status`

Not for file mutations. Not for content search. Not for communication.

### When uncertain

Pick the more specialized tool. `Edit` over `Bash sed`. `Grep` over `Bash grep`. `json_set` over `Edit`. The specialized tool has fewer ways to go wrong.
