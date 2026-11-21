# Review brief: #{{id}} {{title}}

- Role {{role}}, tag {{tag}}, after {{after}}. Route {{route}}, executor {{executor}}.
- Board: `node {{board}}`. Claim: `node {{board}} claim {{role}} <owner> --id {{id}} --run <kind>:<ref>`.
- Read: `{{toolkit}}/skills/team-coordinator/references/worker-protocol.md`, <role skill path>, and the project's `.agents/team/project-protocol.md` if present.
- Checkout <path> at <head sha>. Allowed files: <allowed files>.
- Guards: <write rule, load guard, banned commands from the project's instructions>.
- Never read `.env*` or credentials; ask the lead for what you need instead.
- Board acceptance: {{accept}}

Review the pinned diff <base>..<head> and fix what you find; end with fixes
pushed and a PASS at the head you pushed. First check: `git log -p <test
commit>..<head> -- <locked files>` shows only the lead's test-worker commits.
Do not run test suites.

1. Score every comment: the conditions it needs, frequency 0-10 and impact 1-10,
   with evidence. No specifiable conditions means frequency 0.
2. Cross-check with Jev (`jev-ask.ts` or `jev-decide.ts`) after checking facts
   against source; keep the input and result or the unavailability.
3. Fix only when frequency x impact >= 20, or frequency >= 1 and impact >= 8.
   Report every unfixed comment with its conditions, scores, Jev result and why.
