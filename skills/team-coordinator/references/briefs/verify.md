# Verify brief: #{{id}} {{title}}

- Role {{role}}, tag {{tag}}, after {{after}}. Route {{route}}, executor {{executor}}.
- Board: `node {{board}}`. Claim: `node {{board}} claim {{role}} <owner> --id {{id}} --run <kind>:<ref>`.
- Read: `{{toolkit}}/skills/team-coordinator/references/worker-protocol.md`, <role skill path>, and the project's `.agents/team/project-protocol.md` if present.
- Checkout <path> at <head sha>. Allowed files: <allowed files>.
- Guards: <write rule, load guard, banned commands from the project's instructions>.
- Never read `.env*` or credentials; ask the lead for what you need instead.
- Board acceptance: {{accept}}

Run the runtime verification at <head sha>: <spec or flow>, flags <opt-in flags>,
ports and devices <lane ports, device slot>.

- Expected evidence: <screenshots of each changed surface, a short video of the
  changed interaction>, from the exact candidate build.
- Recover setup hurdles inside these allowed fixes: <list>; never ask the owner
  and never request a secret.
- Rerun a timeout-type failure once, with no timeout bump. Run specs in the
  foreground one at a time and post each pass or fail before the next. Never end
  the turn while a run is live or still owed.

Return the build identity, each result and the retained evidence paths.
