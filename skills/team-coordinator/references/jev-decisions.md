# Jev option decisions

Use `$TOOLKIT/scripts/jev-decide.ts` when choosing among fix or approach options before recommending or dispatching. Routing a task to an executor stays on `$TOOLKIT/scripts/jev-route.ts`. Jev supplies the judgments. The weights, thresholds, and verdict live in `$TOOLKIT/scripts/jev-decide.lib.ts`. The script does not dispatch. `--task <id> --by <owner>` writes a receipt beside
the board and records a `decide` judgment: `answered` when the result has no
holds, otherwise `hold`. It does not call Jev under the board lock.

Run it under Node 22.18+, not Bun. `@typesafe-ai/sdk` 0.7.0 throws "Body already used" on Bun 1.4.4.

```
node "$TOOLKIT/scripts/jev-decide.ts" <input.json> [--dry-run] [--out <result.json>] [--model jev-latest] [--force]
node "$TOOLKIT/scripts/jev-decide.ts" --rescore <result.json> [--out <rescored.json>] [--force]
```

`--rescore` applies today's weights, thresholds, and holds to a saved result's `rawAnswers` and prints the report. It makes no API call and needs no key.

`TYPESAFE_API_KEY` must be set for a live call. The script reads it through the SDK and never prints it. Error text replaces the trimmed key with `[redacted]`. `--dry-run` prints the exact request, the request token estimate, and the largest question token estimate, and does not call the API. The default result file is `<input-basename>.result.json` beside the input. Add `**/*.result.json` to the project's `.gitignore`. A result file holds the text that was sent and the absolute input path.

## Worker consultation and receipts

Follow [worker -> Jev -> coordinating lead -> human](../SKILL.md#decision-and-escalation-chain).
Resolve exact facts from instructions, source, and measurements first. Consult
Jev before asking the lead when the remaining decision needs semantic judgment;
do not invent an option choice or paid call for already explicit requirements.
The rubric is `general`, which fits any engineering choice. Do not invent
measurements or use task routing to select an implementation.

Use an existing task-owned artifact directory outside the checkout, for example
`/tmp/team-task-<id>`. Set `BOARD` to the assigned absolute board script,
`TASK_ID` and `OWNER` to the actual assignment, and `TASK_EVIDENCE` to that
directory. Prepare `choice.json` in the input format below with only necessary,
non-secret context. Keep private payloads out of requests and board summaries.

```bash
node "$TOOLKIT/scripts/jev-decide.ts" "$TASK_EVIDENCE/choice.json" --dry-run
node "$TOOLKIT/scripts/jev-decide.ts" "$TASK_EVIDENCE/choice.json" --task "$TASK_ID" --by "$OWNER"
```

For a yes/no, a small pick, or a preset question, use `$TOOLKIT/scripts/jev-ask.ts` with
the same `--task` and `--by`. Presets are `flaky_or_real`, `blocker_or_nit`, and
`clipped_text`. `--pick a,b[,c,d] --question <q>` is a two-to-four label choice.
`--check-evidence --summary <text>` is the last Jev call before `done`. Helper
subagents pass `--out <dir>` and do not write the board. The lead resolves a hold
with `decide`, and uses `accept` only when the evidence check holds.

The dry run is optional preparation, not a consultation. Make one bounded live
attempt when configured, retain its exit status, and inspect the result's
`recommendation`, `holds`, confidence, and option-order agreement using the
existing thresholds. Preserve the input and full result, including `request`
and `rawAnswers`, not just the recommended label. Do not overwrite earlier
attempts with `--force`. For routing, retain the exact title/role/dependencies
and `jev-route.ts` stdout/stderr; its CLI prints verdict signals, not the full
raw API response.

A sound, confident, hold-free recommendation within existing authorization may
be followed by the worker after checking its factual assumptions. Record the
actual choice and why it is in scope, using the actual worker owner:

```bash
node "$BOARD" decide "$TASK_ID" --summary "Chosen option and in-scope rationale" \
  --ref "$TASK_EVIDENCE/choice.result.json" --by "$OWNER"
node "$BOARD" evidence "$TASK_ID" "$TASK_EVIDENCE/choice.json" "$TASK_EVIDENCE/choice.result.json"
```

Replace the example summary with the real decision. Verify the implementation
with the required checks; Jev is neither test truth nor permission. If the key
is missing, the service is unavailable, or the API errors, preserve the failure
and exit status and tell the lead that no usable verdict exists. Do not attach
a nonexistent result or fabricate one, and do not retry indefinitely.

For `needs_lead`, holds (including order flips), uncertainty, conflicting
evidence, or missing material scope/authority, send the parent/lead one narrow
question with the input/result or unavailability reference, concrete options,
recommendation, and blocker. The lead records the resolved choice with their
actual `--by` identity and a handoff/result `--ref`. `--by jev` stays reserved.
Workers cannot self-clear route holds; lead `route <id> <route> --reason "..."`
remains required. Only the lead asks the human when existing instructions and
evidence cannot resolve a material user decision or authority gap. Child
user-facing questions go through that handoff, not directly to user-question
tools. Never use Jev to override instructions, safety, or tool approvals.

This is guidance using existing receipts. `decide` does not call Jev, validate
the referenced artifact, authenticate `--by`, grant authority, or change routes.

## Input

```json
{
  "decision": "What first step is being chosen",
  "context": "Facts the options share. May be empty.",
  "rubric": "general",
  "options": [
    {
      "id": "angle_guard",
      "title": "Short name",
      "description": "What would ship",
      "evidence": "What was measured"
    }
  ]
}
```

`rubric` is `general` (the default); any other value is refused. The result records it. It asks four dimensions with four levels each. Two to twelve options. Each `id` matches `^[a-z][a-z0-9_]{0,47}$`, is unique, and is not `no_good_option`. The id is the Choice label. `context` may be omitted, null, or empty. `decision` and each option `id`, `title`, `description`, and `evidence` must be non-empty strings.

## Reading the result

`ranking` is the composite, highest first. The composite is evidence 0.40, regression safety 0.25, user value 0.20, and cost 0.15. Risk and cost are inverted, so a higher risk or a higher cost lowers the composite.

`choice` is the first-step pick three ways: forward label order, the same question with labels reversed, and the mean of those probabilities. Choice confidence uses the expected label count (the option ids plus `no_good_option`). `orderConsistent: false` means the pick flipped when the labels were reversed.

`anySound` is a separate yes/no judgment that at least one option is a reasonable first step. A value below 0.5 holds. 0.5 does not.

`recommendation` is an option id only when `holds` is empty. Otherwise it is `needs_lead`. The lead decides what to do with a hold. Saved `rawAnswers` can be re-scored after a weight change with `--rescore`, without a new call.

`holds` is empty only when every check below passes. The strings are exactly what the code pushes:

- `malformed answer <qid>` when an expected answer is missing or unusable. A Score needs a finite `score` from 0 through 3 and a finite `confidence` from 0 through 1, plus finite probabilities. A Choice needs a label in the option ids plus `no_good_option`, a finite `confidence` from 0 through 1, and probability keys equal to that same label set, each finite and from 0 through 1. `any_sound` needs a finite `noul` from 0 through 1. Scoring is skipped, so the composite is not a result.
- `Choice picks no_good_option` when the mean Choice is `no_good_option`.
- `any_sound 0.49 below 0.5` when `anySound` is strictly below 0.5. The number is printed with two decimals.
- `Choice flips with option order (alpha vs beta)` when the forward pick and the reversed pick differ.
- `Choice confidence 0.25 below 0.5` when the mean Choice confidence is strictly below 0.5.
- `composite top alpha differs from Choice top beta` when the composite top and the mean Choice top differ.
- `composite margin 0.040 below 0.05` when the top composite leads by strictly less than 0.05. The margin is printed with three decimals. A margin of 0.05 does not hold.
- `top option has uncertain scores: risk confidence 0.40` when an evidence or risk Score on the composite-top option has confidence strictly below 0.5. Each flag is `<dimension> confidence <two decimals>`, joined with `, `.

There is no separate composite confidence floor. The uncertain-score hold is the only check on Score confidence, and it applies to the top option's evidence and risk only (`HOLD_ON_UNCERTAIN`). An uncertain cost or value Score still appears in that option's `flags` and in the printed ranking, but does not hold: it changes the ranking, not whether a pick is safe.

## What may be sent

The request may contain only `decision`, `context`, and each option's `title`, `description`, and `evidence`, plus the option id as a Choice label. Unknown fields are dropped and named on stderr. They are not sent.

## Refusals before the call

These throw, write no result file, and do not build a client:

- The input is not a JSON object, an option is not an object, or `options` is not an array of 2 to 12 entries.
- `decision`, an option `id`, `title`, `description`, or `evidence` is not a string, is empty, or is over 4000 characters. `context` may be omitted, null, or empty, and the same 4000-character cap applies when it is a string.
- An id fails `^[a-z][a-z0-9_]{0,47}$`, is duplicated, or is `no_good_option`.
- The trimmed `TYPESAFE_API_KEY` is non-empty and appears in the request JSON (`input contains the API key; remove it`). That is a secret check. It runs before `--dry-run` prints the request. A blank or whitespace key does not match. The same check refuses the value of any environment variable whose name has an uppercase `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `DSN`, or `DATABASE_URL` segment (for example `RESEARCH_S3_SECRET_ACCESS_KEY` or `SENTRY_DSN`), when the value is 12 or more characters. The error names the variable, never the value.
- Any text field looks like it holds a credential: a private key block, a Stripe, OpenAI-style, GitHub, Slack, AWS, or Google key, a JWT, a URL with a password, or a `TOKEN=...`-style assignment.
- `--task` names a missing task, or a gated task that is not claimed or is claimed by someone other than `--by`.
- The token estimate is over the limit. The estimate is `JSON.stringify` length divided by 3.5. The whole request must be at most about 56,000 tokens. One question together with the state must be at most about 28,000 tokens. Over either limit, the script tells you to shorten the evidence or split the options. `--dry-run` prints both estimates when the request is inside the limit.
- A live run has no trimmed `TYPESAFE_API_KEY`.
- `--out` resolves to the input path, including when `--force` is set. The parent directory is missing or is not a directory. The output path is a directory. The output file already exists and `--force` was not passed.

The text checks are a convenience, not a privacy guarantee. They catch a bare run of 24 or more numbers, a `data:...;base64,` value or a run of 200 or more base64 characters (`A-Za-z0-9+/`), and an email address. A bare number is an optional minus, digits, and an optional decimal, and the run counts only tokens split on whitespace or `,;:()[]{}`.

## After a paid call

`decide()` does not throw when an answer is malformed. The verdict is `needs_lead`, and the result file keeps the request, the raw answers, and the holds. If `decide()` still throws, the script writes the request, the raw answers, and the error, then exits non-zero. The paid response is not discarded.

## Thresholds

`WEIGHTS` and `THRESHOLDS` are starting guesses. Tune them against real outcomes. Changing them is a code change, not a prompt change. `minDimensionConfidence`, `minChoiceConfidence`, and `minAnySound` are 0.5. `minCompositeMargin` is 0.05. Each of those comparisons is strict: a value equal to the threshold does not hold.
