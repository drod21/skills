---
name: verify-team-board
description: Verify the team board's done gate, owner-thread commands, board view and scored-review completion after changing scripts/team-tasks.lib.mjs, team-tasks.mjs, team-board-view.mjs, team-review.mjs or how jev-ask/jev-decide record judgments.
---

# Verify the team board

The board's gates are protocol rules, so a change to them is verified against the
real functions over every command order within fixed budgets, not against a copy
of the rules. Run from the toolkit root:

```bash
cd "${DEREK_SKILLS:-$HOME/derek-skills}"
bun run test:board                      # gate, thread, view, review suites
node scripts/verify-team-review.mjs     # bounded exhaustive scored-review check
```

None of these need a network, a Jev key, a database or a live board: every board
is in memory and the Jev provider is a fake. Run the narrower file while iterating
(`bunx vitest run scripts/team-board-gate.test.ts`), then the whole set before
calling the change done.

## What each check owns

| Change to...                                         | Run                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `doneBlockers`, judgments, `accept`, `release`, Jev checks, command wiring | `team-board-gate.test.ts` |
| `ask-owner`, `answer`, `note`, `lead-reply`, `answer-read`, delivery | `team-board-thread.test.ts`, `team-board-delivery.test.ts` |
| The board read model (`boardView`, "needs you" sections, moves) | `team-board-view.test.ts`                          |
| `team-review.mjs` parsing, review recording and completion | `team-review.test.ts` and `verify-team-review.mjs`          |
| Run links, wake addresses, `doctor --runs`           | `team-tasks-runs.test.ts`, `team-tasks-runs-gone.test.ts`      |
| Jev scripts                                          | `bun run test:jev`                                             |

The rules under test are listed in [jev-team](../team-coordinator/references/jev-team.md).

## How to read a failure

- The gate explorer reports the **shortest command trace** that breaks a rule.
  Reproduce that trace by hand on an in-memory board before touching code.
- A rule that fails because the oracle and the code disagree is a decision: either
  the protocol changed (update the oracle and the docs together) or the code
  regressed (fix the code). Never loosen the oracle to turn the run green.
- Refused commands must leave the board unchanged; a check that sees a changed
  file after a refusal is a real defect.
- Record what the checks do **not** cover: they do not enumerate review payloads,
  keyboard or voice behavior of a viewer, media playback, or live Jev accuracy.

## When you add a rule

Add the rule to the board code, to the oracle or ghost model in the gate test, and
to [team-board](../team-board/SKILL.md) in the same change. A rule that exists
only in prose, or only in code, will drift.
