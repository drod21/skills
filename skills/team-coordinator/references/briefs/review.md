# Review brief: #{{id}} {{title}}

- Role {{role}}, tag {{tag}}, after {{after}}. Route {{route}}, executor {{executor}}.
- Board: `node {{board}}`. Claim: `node {{board}} claim {{role}} <owner> --id {{id}} --run <kind>:<ref>`.
- Read: `{{toolkit}}/skills/team-coordinator/references/worker-protocol.md`, <role skill path>, and the project's `.agents/team/project-protocol.md` if present.
- Checkout <path> at <head sha>. Allowed files: <allowed files>.
- Guards: <write rule, load guard, banned commands from the project's instructions>.
- Never read `.env*` or credentials; ask the lead for what you need instead.
- Board acceptance: {{accept}}

Review the net diff `<base>...<head>`, fix what you find, push. First check:
`git log -p <test commit>..<head> -- <locked files>` shows only the lead's
test-worker commits. Read `git diff -U10`, not whole files. New tests go in new
files; CI runs suites.

1. Score each comment: conditions, frequency 0-10, impact 1-10, evidence; no
   conditions means frequency 0.
2. Check facts in source, then `jev-ask.ts`/`jev-decide.ts`; keep input and result.
3. Each round, fix only when frequency x impact >= 20, or frequency >= 1 and impact >= 8.
   Report each unfixed comment (conditions, scores, Jev, why).

Submit `node {{board}} review {{id}} <findings.json> --by <owner>`. Never end on
FAIL: end with `PASS at <head you pushed>`, or `BLOCKED at <head>: <item>` for an
owner decision, credential, approval or out-of-scope change once the rest is fixed.
