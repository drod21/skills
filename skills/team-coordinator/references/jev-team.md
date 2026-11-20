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
  journal; a task with no `accept` stays ungated. A check, an accept or a done on a
  gated task also re-verifies each retained copy's checksum (see
  [team-board](../../team-board/SKILL.md)).

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
refuses before Jev is called, and so does any retained file whose bytes no longer
match its checksum directory, preflight included. An image reference token
(`<image:...>`) quoted in text is sent as `[image reference]`. Text uses a 4,000-character tail. Both modes retain
the full evidence snapshot and freshness checks when journaling the judgment.
For a rejected check or hold, use the result's gap and receipt path. The receipt
contains the acceptance criteria and exact request. Use preflight to inspect the
artifact manifest before submitting a revised packet.

Keep a receipt or handoff that carries no acceptance input with
`evidence <id> --supporting <path>`. That material is stored separately from
acceptance evidence. A phased check hashes its selected retained files (up to
25 MiB each) and binds them to
the task criteria. Changes to those files or the criteria require a fresh
check. Attach new acceptance evidence through plain `evidence` before checking.

## Mechanical proof

For a mechanical task, the lead can add `--git-proof <plan.json>` in place of
`--accept`. Set `repo` to the absolute checkout root and `candidate` to the full
reviewed commit SHA. The verifier compares checkout HEAD with that commit.
For a squash merge, also set `base`, `landed` and `target` to the pinned base
SHA, squash SHA and full local or remote-tracking ref. Fetch the target first
when relevant. The verifier checks ancestry, parent and tree identity.

To require a GitHub Actions result, add a `ci` object with `repository`
(`owner/repo`), numeric `workflow`, `run` and `attempt` IDs, `workflowPath`,
`workflowCommit` and the exact `job` and `step` names. Pin the workflow commit
from trusted source. The verifier compares the candidate workflow blob against
it, then uses read-only GitHub Actions data to require a successful same-repo
push run, job and step at the candidate SHA. For a squash proof, set
`ci.on` to `landed` to verify the run at the squash SHA instead. The lead
chooses a workflow that checks out and tests the specified commit.

Run `verify-git <id> --by <claim-owner>` before `done`. Set both `--git-proof`
and `--accept` for mixed tasks and also pass a phased Jev check whose selected
evidence covers the semantic criteria at the pinned candidate.
