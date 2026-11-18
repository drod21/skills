# Jev-first team flow: the rules the board keeps

Jev is the default decision maker for delegated work. The lead routes every task
through Jev, workers ask Jev before they ask the lead, and the lead handles what Jev
holds and the area's delivery. The chief of staff resolves cross-area work and
queues human decisions only when existing instructions and evidence cannot answer
them. The single-task protocol was modeled as a statechart and each rule below was
checked against every reachable state. The board's gate tests
([verify-team-board](../../verify-team-board/SKILL.md)) hold the code to them.

| Rule                      | Sentence                                                           |
| ------------------------- | ------------------------------------------------------------------ |
| NeverDoneWhileAskingJev   | A task is never done while its worker still waits on Jev.          |
| NeverDoneWhileHeld        | A task is never done while a question sits with the lead.          |
| NeverDoneWhileAskingHuman | A task is never done while the human has not answered.             |
| NeverDoneUnchecked        | A task is never done without evidence.                             |
| NeverDoneUnconfirmed      | A task is never done on evidence nobody confirmed.                 |
| NeverQuestionWithoutOwner | A question to Jev always has a worker who owns the task.           |
| NeverEvidenceWithoutOwner | Evidence waiting for review always has a worker who owns the task. |

A goal written as a rule that must break, `GoalJevDecidesAlone`, shows the shortest
path with no lead step: Jev routes, a worker claims and asks, Jev answers with a
confident pick, the worker attaches evidence, Jev confirms it, the worker marks it
done. That path is allowed only for a task without holds; every hold sends the
decision to the lead.

## What the model leaves out

- One task at a time: file collisions between parallel workers and dependency order
  are not modeled.
- No clock: stale claims and heartbeats are a lead action ("the lead releases a dead
  claim"), not a timeout.
- `done` does not call Jev. For a task with `accept`, `doneBlockers` enforces
  NeverDoneUnchecked, NeverDoneUnconfirmed and NeverDoneWhileHeld from the decision
  journal; a task with no `accept` stays ungated.

## Current acceptance evidence

When a task holds reports from earlier phases, attach all receipts first, then
select current proof using the exact retained paths from `team-tasks.mjs show <id>`:

```bash
node "$TOOLKIT/scripts/jev-ask.ts" --check-evidence --task 1 --by worker-1 \
  --summary "Merged and verified" --phase "merged acceptance" \
  --current-evidence /retained/path/merge.txt \
  --current-evidence /retained/path/checks.txt
```

Add `--preflight` to the same evidence-check command to validate the packet
locally and inspect the acceptance criteria and artifact manifest. Preflight
does not call Jev or record a verdict. Compare the manifest with the criteria
before submitting the live check.

`--phase` and repeatable `--current-evidence` are check-only and must be supplied
together. Phase names the acceptance checkpoint; the task stays `claimed` until
`done`. Phase and summary are declarations, not proof. Selected receipts are
the only evidence sent to Jev within the 12-item, four-image caps. Explicitly
select any baseline needed for the comparison. Neither filenames, attachment order nor words such as
"BLOCKED" establish which report is current, and a basename alone cannot select a
retained full path. An unreadable, guarded, over-cap or out-of-range selection
refuses before Jev is called. Text uses a 4,000-character tail. Both modes retain
the full evidence snapshot and freshness checks when journaling the judgment.
For a rejected check or hold, use the result's gap and receipt path. The receipt
contains the acceptance criteria and exact request. Use preflight to inspect the
artifact manifest before submitting a revised packet.
