# Review brief: #{{id}} {{title}}

- Role {{role}}, tag {{tag}}, after {{after}}. Route {{route}}, executor {{executor}}.
- Board: `node {{board}}`. Claim: `node {{board}} claim {{role}} <owner> --id {{id}} --run <kind>:<ref>`.
- Read: `{{toolkit}}/skills/team-coordinator/references/worker-protocol.md`, <role skill path>, and the project's `.agents/team/project-protocol.md` if present.
- Checkout <path> at <head sha>. Allowed files: <allowed files>.
- Guards: <write rule, load guard, banned commands from the project's instructions>.
- Never read `.env*` or credentials; ask the lead for what you need instead.
- Board acceptance: {{accept}}

Review the net diff `<base>...<head>` and fix what you find; end with fixes
pushed and a PASS at the head you pushed. First check: `git log -p <test
commit>..<head> -- <locked files>` shows only the lead's test-worker commits.
Add tests only in new files; a test worker or CI runs suites. Read the diff
only, never whole files: read `git diff -U10` output, and open a few lines past
a hunk only to confirm a specific finding. Fix each finding while the diff is
fresh.

1. Score every comment: conditions, frequency 0-10, impact 1-10, evidence. No
   specifiable conditions means frequency 0.
2. Check facts against source, then Jev (`jev-ask.ts` or `jev-decide.ts`);
   keep the input and result or the unavailability.
3. On every round fix only when frequency x impact >= 20, or frequency >= 1 and
   impact >= 8. Report each unfixed comment (conditions, scores, Jev, why) and
   any blocked qualifying issue with its owner.

Submit `node {{board}} review {{id}} <findings.json> --by <owner>`; return the
pushed head. Never end on FAIL. Your last line is `PASS at <head you pushed>`,
or `BLOCKED at <head>: <item>` when only an owner decision, a missing
credential or approval, or a change outside the PR remains, after you have
fixed everything else.
