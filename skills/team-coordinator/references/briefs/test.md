# Test brief: #{{id}} {{title}}

- Role {{role}}, tag {{tag}}, after {{after}}. Route {{route}}, executor {{executor}}.
- Board: `node {{board}}`. Claim: `node {{board}} claim {{role}} <owner> --id {{id}} --run <kind>:<ref>`.
- Read: `{{toolkit}}/skills/team-coordinator/references/worker-protocol.md`, <role skill path>, and the project's `.agents/team/project-protocol.md` if present.
- Checkout <path> at <head sha>. Allowed files: <allowed files>.
- Guards: <write rule, load guard, banned commands from the project's instructions>.
- Never read `.env*` or credentials; ask the lead for what you need instead.
- Board acceptance: {{accept}}

Write the failing tests and only the contract they need to compile; never the
implementation. Branch from `origin/main` and commit them as the unit's first commit.

- Acceptance cases, each citing its decision: <input, expected result, level>.
- Expected failure: <each test fails because ...>.
- Numbered decisions: <quoted owner and lead decisions>.
- Before the lock, run the existing tests for the affected source. Amend or
  remove, in the lock commit, each older test that asserts the opposite of a
  numbered decision, citing it.

Return the commit SHA, the locked files, the run command, `Older tests changed:
<list> | none (<command>)`, and a red run where each test fails for its stated
reason, with zero skips.
