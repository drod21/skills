---
name: derek-mode
description: Follow Derek's working conventions when asked for Derek mode, /derek-mode, or to work in Derek's style.
disable-model-invocation: true
---

# Derek mode

Apply the user's current directions first. This mode does not grant permission to
expand scope, merge, deploy or contact others. Follow the repository's `AGENTS.md`
for project requirements.

## Finish authorized work

Carry implementation through affected checks, fixes and applicable runtime
verification. Continue reversible work within the agreed scope without asking for
the same permission again. Ask when a missing decision changes behavior, scope,
cost, data or an irreversible action, and explain what requires the answer. For a
report-only request, return findings and leave files unchanged.

## Make responses actionable

Lead with the result or next action. Use short paragraphs, and numbered steps when
the user must do several things. State what now works, what remains, and the one
next action when work is blocked. Keep errors factual. Include enough evidence to
assess a claim without recounting every command. Name each item in plain words
with its number in parentheses, never a bare number. When the owner already
answered, quote the answer instead of asking again.

## Prove the affected behavior

Separate source checks, automated tests, runtime observations, hosted checks and
production acceptance, and say which evidence supports each conclusion and which
acceptance remains unverified. A build or synthetic test does not prove
physical-device behavior. Find the affected verification workflow through the
project's task map and inspect every changed UI view in the running affected
platform. Use independent review when requested or required by the delivery
workflow. Preserve failed evidence and unrelated baseline failures.

Test observable behavior and real failure modes. Avoid tests that repeat the
implementation, derive expected results with the same logic under test, or only
assert that a mock returns its configured value. Add tests when they would catch a
meaningful regression, not to satisfy a count.

## Keep changes bounded

Prefer the smallest change that solves the observed problem. Before adding
complexity for a speculative race or security edge case, apply
[scope-safety](../scope-safety/SKILL.md). Preserve unrelated dirty work and shared
resources, and keep edits and staging within scope.

When delegating, read the user's model configuration if present
(`~/.claude/rules/pstack-models.md` or `~/.agents/pstack-models.md`) and use its role
mapping rather than copying model choices into a skill. Delegate only within the
task's authorization.

Keep comments for non-obvious reasons, constraints and tradeoffs. Do not narrate
the code, label every step or repeat names and types in prose; prefer clearer code
when it removes the need for a comment.
