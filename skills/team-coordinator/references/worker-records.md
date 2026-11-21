# Route and judgment records

The coordinator records a routing verdict with `jev-route.ts --add` or `--task
<id>`. `--task` reads title, role and `after` from the board; do not pass those
flags with it. It refuses a done or cancelled task before calling Jev and does
not lift `needs_lead` or replace a route a lead set with `route <id> <route>
--reason "..."`; only that command leaves a hold or changes such a route, and
`--reason` is required even to return to the verdict route. `--by jev` is
reserved for verdicts on `route`, `add` and `decide` (matched after folding case
and width and dropping invisible format characters). `add --reason` needs
`--route`, and `add --by` needs a journaled decision. An open task whose route is
null, with no route decision in its journal, takes the verdict route, including
`needs_lead`; `release` alone does not apply a stored hold.

A worker may record a sound, confident, hold-free Jev option recommendation
within authorized scope with `decide <id> --summary "..." --ref <result-path> --by
<actual-worker-owner>`. Verify assumptions and affected checks; the result is
neither permission nor proof. For `needs_lead`, holds or order flips,
uncertainty, conflicting evidence, missing scope or authority, or an unavailable
or failed Jev call, send the lead the narrow question with the input and result
(or failure) reference, options, recommendation and blocker. Use Node 22.18+, the
existing thresholds and one bounded real attempt; no invented result, no endless
retries. See [Jev decisions](jev-decisions.md). `--ref` and `--by` are trimmed
and a blank value is refused.

All child questions for the human go through the parent lead, not a direct
user-question call. Do not re-ask for already authorized work. The area lead
handles authorized decisions and escalates materially missing information,
decisions or authority to the chief of staff's queue. The lead records escalated
option decisions with their actual `--by` identity; workers never impersonate the
lead or Jev. A choice receipt does not clear a route hold. User and developer
instructions, safety rules and the tool-approval holder's control remain
unchanged: these are agent obligations, not CLI enforcement.

Board statuses are `open`, `claimed`, `done` and `cancelled`. Decisions, evidence
paths and a run link live on the task, including after `done`. The board has no
execution engine; a heartbeat only says you are alive. `list` shows open and
claimed tasks (`list --all` is history), `show <id>` prints one task, and `stale`
and `doctor` are read-only, so use them when only inspection is authorized. A file
under the temp directory is copied beside the board, and on a task with `accept`
every local file is, so the check judges the bytes you attached; other paths, URLs
and notes are stored as given. `jev-route.ts --calibrate` reads outcomes before a routing
threshold changes. A lock acquisition error is a coordination failure to report,
not a reason to spin or reset state.
