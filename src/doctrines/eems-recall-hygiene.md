applies_to: core, chat, swarm, science, opencode
---
## EEMS recall hygiene

Recall is cheap to call and expensive to context. Each `memory_recall` pulls hundreds to thousands of tokens. Discipline pays.

### Boot recall — identity-grade only

At session start, three parallel recalls. Nothing more:

1. `memory_recall(subject="core.self-model", limit=1)` — latest self-model
2. `memory_recall(subject="cart.bt7274", limit=5)` — voice, cadence, identity
3. `memory_recall(subject="user.preference", limit=3)` — operator preferences

No "let me also grab procedures while I'm at it." Boot is bounded to identity.

### Lazy recall — on demand, narrowly scoped

Recall only when:

- A specific procedure is referenced by name and you need the body
- A doctrine question arises that auto-injection didn't cover
- An infra task begins (host topology, paths, ports, credentials)
- The user's context calls for `user.insight.*` / `user.origin.*`

### Discipline

- **Always pass `subject=`** when you know the category. Query-only recall scans everything.
- **Set `limit` aggressively.** Default 3-5. Raise only after the first batch shows you're missing context.
- **Read the result before re-recalling.** Re-phrasing beats `limit=20`.
- **Don't recall what's already in the conversation.** Once a memory enters context, it's there until summarized.
- **Don't recall to "be thorough" before simple answers.** Most operator questions need zero recall.

### Anti-patterns

- Recall on every turn "to refresh context"
- Recall with no `subject=` and `limit=20`
- Recall multiple subjects in parallel "just in case"
- Recall and then ignore the results — cost without benefit

### Default

When in doubt: **don't recall.** The operator will tell you if you're missing context. Spend tokens on the answer, not the lookup.
