# Owner preferences

Maintained by the chief of staff under [the operating cycle](operating-cycle.md).
This is sourced working guidance, not authorization and not a replacement for the
repository's `AGENTS.md`.

A project keeps its own copy of this file (for example
`docs/owner-preferences.md`) and cites it in every worker brief. The entries
below are the toolkit owner's standing defaults. A project entry for the same
scope supersedes a default here; keep the superseded entry with its date.

## Entry format

Each lesson records: source and date, scope, whether it is an explicit preference
or a tentative inference, the rule, examples or exceptions, and supersession.
Explicit corrections update guidance directly. Inferred patterns stay tentative
until the owner confirms them; silence and accepted changes prove nothing about a
universal preference. Conflicts use the latest explicit applicable instruction.
Never store secrets, raw voice recordings or unrelated personal information.
Preferences guide drafts; they never broaden authorization or weaken checks.

## Default: team operating pattern

Scope: agent coordination and human product review.

- One lead agent per area of focus, and a chief of staff that oversees them.
- Decisions and reviews reach the human through one prioritized queue, in batches.
- Every UX change and product review carries screenshots and a short, playable
  feature video from the exact candidate build, linked in the handoff or completion
  report. Missing or stale captures leave UX work unfinished.
- Review works by voice and keyboard shortcuts; leads bring useful new ideas.
- Learn from actual owner feedback so recommendations need fewer corrections.
- Exceptions: internal and documentation-only changes with no UX effect need no
  artificial demo; runtime limits are reported honestly. Production release authority and tool
  approval stay with the session and repository instructions.

## Default: tests before builders

Scope: every unit dispatched to a builder. Procedure: [tests
first](../SKILL.md#tests-first).

- The lead's plan carries the acceptance cases; a lightweight worker turns them
  into failing tests before the build task starts.
- Builders make those tests pass and never edit them.
- The goal is not spending time fixing tests after the build.

## Default: no unrequested guardrails in specs

Scope: every spec and spec brief.

- Specs add no age gates, advice lines, safety warnings or caveats unless the
  owner asks for one. A guardrail the owner asks for is its own decision and
  defaults to off. Spec briefs cite this entry.

## Default: the lead decides and reports

Scope: the lead's reports and decisions.

- The codebase is the lead's. Decide and report reversible calls without
  deliberating at length. Escalate only production release, money, the owner's
  own data or action, a change that loosens a consent or privacy boundary, and
  one-way doors. Present a boundary change once, with the code's reason for the
  gate and both options.
- No closing "say X if you want" offers.
- When a decision's wording is ambiguous at a boundary, state which reading was
  built.
- Exception: this covers product judgment, not outside facts. A user-facing claim
  about a provider's data retention or training is checked against that
  provider's current terms before it ships.

## Default: nothing waits in review

Scope: reviewers and adversaries.

- The reviewer already has the diff loaded, so the reviewer fixes what it finds
  and ends at a PASS on the head it pushed. See the coordinator's review
  instructions.

## Default: answer in the owner's words

Scope: every report to the owner.

- Lead with the result or the next action. Name each item in plain words with its
  number in parentheses, never a bare number. When the owner already answered,
  quote the answer instead of asking again.
