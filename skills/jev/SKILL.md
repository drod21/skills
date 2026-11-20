---
name: jev
description: Use the Jev judgment scripts (jev-route, jev-decide, jev-ask, jev-batch, jev-select, jev-ui) to route tasks, score fix options and answer bounded yes/no, pick and evidence questions with calibrated probabilities. Load before calling any jev-*.ts script or recording a Jev judgment.
---

# Jev scripts

Jev is a TypeSafe System One decision model: it answers typed questions about
text, images and application state with calibrated probabilities. These scripts
wrap it with thresholds, holds, receipts and privacy guards. Jev supplies
judgment, never permission, test truth or proof. For general integration craft
(writing good typed questions) use the `typesafe-ai` skill.

```bash
TOOLKIT="${DEREK_SKILLS:-$HOME/derek-skills}"
```

Run every script with **Node 22.18+** (not Bun: `@typesafe-ai/sdk` 0.7.0 throws
"Body already used" on Bun 1.4.4). A live call needs `TYPESAFE_API_KEY` in the
process; the scripts never print it, redact it in errors and refuse input that
contains it. Install dependencies once with `pnpm install` in the toolkit.

| Script             | Question it answers                                       | Detail                                                        |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------- |
| `jev-route.ts`     | Which route, role and executor should carry this task?    | [coordinator Plan and route](../team-coordinator/SKILL.md#plan-and-route) |
| `jev-decide.ts`    | Which of 2-12 options is the right first step?            | [Jev decisions](../team-coordinator/references/jev-decisions.md) |
| `jev-ask.ts`       | A yes/no, a 2-4 label pick, a preset, or the evidence check before `done` | [Jev decisions](../team-coordinator/references/jev-decisions.md) |
| `jev-batch.ts`     | Many typed questions over shared context in one request   | [execution tools](../team-coordinator/references/jev-execution.md) |
| `jev-select.ts`    | Which long sections matter (filter) or can be summarized (compact)? | [execution tools](../team-coordinator/references/jev-execution.md) |
| `jev-ui.ts`        | Which observed control is the next action on a screen?    | [execution tools](../team-coordinator/references/jev-execution.md) |

Shared pieces: `jev-guard.lib.ts` (secret and size guards), `jev-executors.lib.ts`
plus `jev-executors.catalog.mjs` (the registry of executors per route: facts only,
no quality ranking), `team-catalog.mjs` (roles, routes, checks). A project adds
roles in `team-roles.json` and `jev-decide` rubrics in `team-rubrics.json`, both
beside the board.

## Rules that always apply

1. Resolve exact facts yourself first. Only a remaining semantic judgment goes to
   Jev, and only before asking the lead.
2. One bounded live attempt. A dry run is preparation, not a consultation. A
   missing key, unavailable service or API error is reported honestly; never
   fabricate a verdict or retry indefinitely.
3. Retain the input, the full result (including `request` and `rawAnswers`) and
   the exit status. Do not overwrite earlier attempts with `--force`.
4. Exit codes: 0 answered or next action, 3 hold, 1 refused input; selection also
   returns 2 for a rejected summary.
5. A `needs_lead` verdict, a hold, an option-order flip or low confidence goes to
   the lead with the input, result, options and a recommendation.
6. Nothing secret goes in a request: no credential files, tokens, keys, emails,
   long numeric or base64 runs. At most 12 evidence items and 4 images (each side
   280-1568 px).
7. Thresholds and weights are starting guesses in code, not prompts. Change them
   in `jev-route.lib.ts` / `jev-decide.lib.ts` with a test, after `--calibrate`
   and `--rescore` against saved results.

Testing the scripts without a key: the vitest suite injects a fake provider
(`pnpm test:jev` in the toolkit). It checks request shape and plumbing, not
Jev's semantic accuracy.
