# Build brief: #{{id}} {{title}}

- Role {{role}}, tag {{tag}}, after {{after}}. Route {{route}}, executor {{executor}}.
- Board: `node {{board}}`. Claim: `node {{board}} claim {{role}} <owner> --id {{id}} --run <kind>:<ref>`.
- Read: `{{toolkit}}/skills/team-coordinator/references/worker-protocol.md`, <role skill path>, and the project's `.agents/team/project-protocol.md` if present.
- Checkout <path> at <head sha>. Allowed files: <allowed files>.
- Guards: <write rule, load guard, banned commands from the project's instructions>.
- Never read `.env*` or credentials; ask the lead for what you need instead.
- Board acceptance: {{accept}}

Make the locked tests pass. Never edit, skip, delete, loosen or re-time a locked
file; add tests only in new files.

- Test commit: <sha>. Locked files: <list>. Run: <command>.
- Older tests changed by this rule: <list> | none (<command>).
- A locked test that looks wrong: stop that part, report the test, reason and
  evidence to the lead, and carry on with the rest.
- Branch from the test commit; carry other packets' commits only for: <named dependencies | none>.
- Run your adversary review in the foreground before any pull request.

Return the head, changed files, the green run, evidence paths and blockers.
