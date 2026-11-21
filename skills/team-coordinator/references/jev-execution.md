# Jev execution tools

Run with Node 22.18+; configure the existing `TYPESAFE_API_KEY` in that process.
When the key lives on another machine, run there through authorized SSH with a
scoped artifact bundle; keep credentials on that machine and preserve its
unrelated work.
The scripts return exit 0 for answered/next-action results, 3 for holds, and 1
for refused input. Selection also returns 2 for a rejected summary. Every model
response, including malformed answers and service failures, has a receipt.
`jev-ask` receipts retain the service-reported `model`, or `null` when no model
was returned. Cached older receipts stay unchanged; do not infer their evaluator
from a parsing worker's routing record or a later service response.
Attach result artifacts through the board's existing `evidence` command.
These tools do not confirm board acceptance; run `jev-ask --check-evidence`
last, after review updates and final evidence are recorded.

## Batch judgments and content evaluation

```sh
node "$TOOLKIT/scripts/jev-batch.ts" questions.json --out /tmp/jev-task-artifacts
```

```json
{
  "context": "Assess the supplied Acme page for a shopper choosing an order tracker.",
  "items": [
    {
      "id": "heading_matches",
      "context": "Heading: Track your orders. Body: See every shipment and its history.",
      "ask": { "kind": "yes_no", "question": "Does the heading accurately describe the body?" }
    },
    {
      "id": "next_step",
      "context": "The page is open and its heading is visible.",
      "ask": {
        "kind": "pick",
        "question": "Which step verifies the call to action?",
        "labels": {
          "inspect": "Inspect the observed call to action",
          "stop": "Evidence is insufficient"
        }
      }
    }
  ]
}
```

Question IDs are unique lowercase identifiers. Each question is at most 300
characters; picks have two to four identifier labels with descriptive values.
Shared context is at most 12,000 characters; per-item context at most 6,000.
Requests split at 24 questions or 24,000 serialized characters. A single item
that cannot fit is refused before any call. Existing text/credential guards
apply. No input is silently truncated. Missing, malformed, uncertain, or
unavailable answers become holds using the existing ask thresholds.

For review cross-checks, include each finding's conditions, frequency, impact,
rationale, and relevant evidence in item context and ask whether the scoring
is supported. Inspect the answer; a confident disagreement still needs the
decision/escalation chain. Record its receipt in the finding's `crossCheck`.

## Evidence selection and compaction

```sh
node "$TOOLKIT/scripts/jev-select.ts" sections.json --out /tmp/jev-task-artifacts
```

Input has `mode` (`filter` or `compact`), `goal`, and `sections`. Each section has
`id`, `source` (URL/path/thread reference), `offset` (character offset), `text`,
and optional `pinned: true`. Pin instructions, authorization, active decisions,
blockers, and required evidence. Long sections split into 5,000-character parts
with original IDs, part numbers, and adjusted offsets. Pins and uncertain
sections are retained. Confidently irrelevant sections are listed in `omitted`
for filtering, or `toSummarize` for compaction. The artifact preserves all text.

The lead writes a summary of `toSummarize`; Jev never writes prose. To verify
it, supply `summary` with the original sections and goal. The tool checks every
section, including pins, for recoverability and refuses a clean verification
if any answer is no, missing, or uncertain. For a large handoff, verify topic
groups with an appropriate summary per group. Combined goal/summary must fit
the batch context budget. Reload the retained originals whenever evidence is
insufficient. These tools prepare handoffs; they do not intercept automatic
harness compaction.

## Browser, simulator, and emulator flows

```sh
node "$TOOLKIT/scripts/jev-ui.ts" observation.json --out /tmp/jev-task-artifacts
```

Input has `goal`, `maxActions` (1–50), `history` (initially `[]`), and
`observation`: `surface` (`browser`, `simulator`, or `emulator`), `identity`
(tab/device/build identity), `state` (current grounded observation), and
`controls` (up to three `{ id, description, action }` objects mapped to actual
observed targets). Supply only authorized candidate actions. Use harness
browser/device tools to observe and act; keep exact target mappings locally.

The command returns `action` with the selected observed control, or a terminal
state: `complete`, `blocked`, `ambiguous`, `hold`, `max_actions`, or `stuck`.
Before acting, re-observe and confirm the observation fingerprint still matches;
if it changed, stop and plan against the new state. After acting, replace
`observation`, carry forward the returned `history` unchanged, and run again
until terminal. Inspect actual completion evidence before reporting success.

For an integrated harness adapter, import `runUiFlow` from `scripts/jev-ui.ts`
and supply `observe()` and `act(control, observation)` callbacks. It runs the
loop, re-observes before each action, and returns `stale` if targets changed.
Adapters must use harness-authorized tools and existing approval rules. No
standalone browser/device driver or executable command is selected by Jev.

## Scored review records

```sh
node "$TOOLKIT/scripts/team-tasks.mjs" add qa-worker 'Review the patch' --review --accept 'Scored findings dispositioned and evidence checked'
node "$TOOLKIT/scripts/team-tasks.mjs" review 1 findings.json --by reviewer-owner
node "$TOOLKIT/scripts/team-tasks.mjs" review-report 1
```

Use the actual returned task ID and claim owner. Input is `{ "findings": [...] }`.
Each finding requires `id`, `comment`, `conditions` (nonempty text or `null`),
`frequency` (integer 0–10), `impact` (integer 1–10), `rationale`, `crossCheck`,
and `disposition`. Unknown conditions normalize frequency to 0.

`crossCheck` is `{ "status": "checked", "receipt": "<retained-path>" }` or
`{ "status": "unavailable", "evidence": "<failure-evidence>" }`.
`disposition` is `pending`, `fixed` with `evidence`, `deferred` with `reason`,
or `blocked` with `reason` and `owner`, always in an object with a `status` field.
Only qualifying findings may be fixed; only findings below the agreed threshold
may be deferred. Pending and blocked findings prevent `done`, even with
`--force`. Subsequent submissions must retain every previous finding ID and
its comment, conditions, scores, and rationale; only disposition and cross-check
may change. Correct a mistaken submitted finding through the lead's task
adjudication rather than silently replacing its content.
Submission records a choice that invalidates an earlier acceptance check.
Completion stores a report with every unfixed comment, scores, cross-check,
disposition and score product. Empty findings explicitly record a clean review.
Legacy tasks remain usable; every newly dispatched reviewer task must use
`--review`. As with existing judgments, recorded identities and evidence
references are a coordination protocol, not authenticated proof.

## When to cross-check with Jev

Use Jev at meaningful verification checkpoints and when interpreting evidence
needs judgment; do not add a paid call for every click or routine lookup. The
lead plans and writes; Jev selects or evaluates supplied evidence and options.

- **Browser work:** capture the affected page after the relevant interaction with
  the harness-authorized browser tools. Give Jev the screenshot, expected
  behavior, viewport and steps. Use `jev-ask.ts --preset clipped_text` for
  clipping or overlap, `--yes-no` for a specific acceptance question, `--pick`
  with two to four concrete authorized options for an ambiguous next action.
  Inspect the page yourself and verify navigation, persistence and network claims
  through the actual browser; a screenshot judgment proves only what it shows.
- **Simulator or emulator work:** run the affected flow with the authorized
  device tools and capture each changed surface. Give Jev current screenshots,
  platform and device, build identity, steps and expected state. Include logs
  with `flaky_or_real` when diagnosing a failure. Re-run the real interaction
  after a fix. Keep simulator, physical-device and backend evidence distinct;
  Jev's interpretation never establishes unseen behavior such as audible playback.
- **Context compaction and resume:** before a planned compaction or durable
  handoff, retain a summary with the objective, exact user constraints and
  authorization, checkout/branch/HEAD, changed files, decisions and rationale,
  evidence paths and results, unresolved findings and scores, owned resources,
  active task IDs, blockers and next action. Ask Jev a bounded `--yes-no`
  question comparing the original excerpts with the proposed summary for
  omissions or changed meaning. `--context` and `--context-file` retain only the
  last 3,000 characters, so keep each comparison inside that and split larger
  handoffs by topic. Correct confirmed omissions, and on resume re-read the
  retained artifacts and reconcile the live checkout, tasks and resources.

Selection, filtering and progress patterns, all within the authorized task:

- **Ground UI choices in observed controls.** Enumerate up to three plausible
  controls from the current DOM or accessibility snapshot and run `jev-ui.ts`;
  keep each option mapped to the observed locator. Execute through authorized
  tools, then take fresh evidence; never invent a selector or reuse a target after
  the screen changes.
- **Check progress before repeating an action.** Compare goal, before/after state
  and recent actions. Use bounded questions or choices to distinguish completion,
  ambiguity, an error, a blocker and no progress. Confirm observable completion
  directly. When an action repeats without progress or Jev is unsure, inspect the
  state and return the judgment to the lead. Jev's choice never authorizes an
  external action.
- **Select context before summarizing.** Pin user constraints, authorization,
  accepted decisions, active work, blockers and evidence references first. Give
  remaining transcript sections stable IDs and ask whether each contains facts
  needed for the current goal. Keep uncertain or unjudged sections. The lead
  writes the summary of sections selected for compression and preserves the
  original artifacts. Check that concrete facts from compressed sections can still
  be recovered from the summary plus retained context.
- **Filter large evidence by relevance.** Split long research pages,
  documentation or logs into identified sections with source URLs or paths and
  offsets. Ask which sections help answer the actual task question. Return
  original excerpts in source order, record omitted section IDs and reasons, and
  retain the full artifact. Keep uncertain sections; a filtered excerpt is not
  proof that the full source contains no other evidence.
- **Evaluate content meaning.** For website or content work already in scope,
  provide the intended audience, search intent, page text and concrete criteria.
  Ask whether headings match the body and whether the page answers its intended
  question. The agent writes revisions; code checks metadata, links and schema.
  Semantic judgments are editorial evidence, not measured rankings. Apply the
  review threshold to proposed fixes.
- **Batch related judgments.** Prefer one bounded state with multiple typed
  questions over re-sending the same artifact for each question. Use
  `jev-batch.ts` for multiple questions and `jev-select.ts` for filtering or
  compaction selection; they retain complete bounded inputs and split requests
  instead of tail-truncating. `jev-ui.ts` supplies a bounded action protocol and
  `runUiFlow` runs observe/choose/act/verify through supplied harness adapters.
