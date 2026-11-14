# Shared worker protocol

Use this when participating in an authorized task-board team. For standalone
specialist advice or edits, do not create or claim board tasks automatically.

In the [standing team cycle](operating-cycle.md), report to your assigned area
lead. Read applicable [owner preferences](owner-preferences.md) before drafting
and include their references in your handoff. Return product evidence using the
cycle's review packet, including screenshots and video for product reviews. Send
new ideas and candidate preference lessons, with supporting evidence, to the
lead; do not modify shared preference memory or create a separate human inbox.
The chief of staff consolidates human decisions across leads.

`$TOOLKIT` below is `${DEREK_SKILLS:-$HOME/derek-skills}`. Use the coordinator's
absolute script paths even when editing in another checkout.

1. **Read scope, inspect the tree.** Read the assigned scope and inspect the
   working tree before edits. Load the role skill and the project's task map and
   command skill before any check, build or runtime action. Preserve an assigned
   checkout and verify its pinned head. For a new unit branch, branch from the
   verified remote default branch and report if it is behind. Builders continue
   from the assigned test commit (including any lead-approved test-worker
   amendment) rather than starting again from the default branch. On an existing
   unit branch, fetching and merging that branch before a push are allowed.
   Commit and push work in progress at each green step, so the lead can hand the
   same worktree to another executor when a provider quota ends.
2. **Claim.** `node "$TOOLKIT/scripts/team-tasks.mjs" claim <role>
   <unique-owner-id> --run <kind>:<ref>`. `kind` is `workflow`, `t3_task`,
   `subagent` or `session`. Claim is atomic but not authenticated: it selects the
   first open task for the role whose dependencies are done and whose route is
   neither `needs_lead` nor `lead_workflow`. It does not enforce executor choice
   or file ownership. Check the returned ID, title and route against your
   assignment. If it is another task, stop and tell the coordinator; do not work
   it or mark it done. If `null`, report no eligible work. Do not poll
   indefinitely or steal a claim. Given your own thread ID, pass `--wake
   <threadId>`. If the coordinator already claimed for your exact owner, verify
   that record instead of claiming again. Given a task ID, add `--id <id>`: it
   takes exactly that task or fails with the reason and changes nothing.
3. **Know your side of tests first.** A builder builds against the locked tests
   its brief names and never edits, skips, deletes, loosens or re-times a locked
   test file; it adds tests only in new files. If a locked test looks wrong, the
   builder stops that part, reports the test, reason and evidence to the lead and
   carries on with the rest. A test worker writes the tests and the minimal
   contract they compile against, never the implementation, and is the only worker
   who amends a locked test, in its own commit, when the lead assigns it.
4. **Work inside the boundary and follow the escalation chain.** Resolve known
   facts first, consult Jev for unresolved semantic judgments, then escalate to
   the parent lead. Ask Jev yourself with `node "$TOOLKIT/scripts/jev-ask.ts"
   --task <id> --by <your-owner>` (`--preset flaky_or_real`, `blocker_or_nit` or
   `clipped_text`, or `--pick` for a small choice); scored options use
   `jev-decide.ts --task <id> --by <your-owner>`. On a task with `accept`, `--by`
   must be the claim owner. Never pass a credentials file, token or password as
   context or evidence: `jev-ask` refuses it and lists the item as not sent.
   Helper subagents pass `--out <dir>` and do not write the board. Routing uses
   `jev-route.ts`; never use it as a substitute for option scoring. Return
   cross-domain decisions, new dependencies, shared-file collisions and missing
   prerequisites to the lead with that evidence. Keep failed or blocked tasks
   claimed: there is no blocked status, and only the coordinator releases or reaps
   a claim. On a long task run `heartbeat <id> [--run <kind>:<ref>]` now and then
   so `stale` can tell you are alive. Do not edit live board JSON or delete its
   lock to recover; the script clears a dead lock and restores a corrupt board
   itself. Builders run their adversary review in the foreground. Never end a turn
   to ask, propose a next step or stop after setup. Wait out the project's load
   guard by checking `uptime`, sleeping and re-checking; never override it.
5. **Hand off.** Return task and owner ID, checkout and head, changed files,
   outcome, checks with actual results, evidence locations and remaining blockers.
   For worktree isolation, give the coordinator a concrete commit or patch for
   integration and do not imply a child worktree's success verifies the
   integrated parent checkout. A diagnosis note states "reproduced with the
   owner's inputs: yes/no"; a "by design" or "not built yet" verdict goes to the
   owner only with yes. When core logic returns the action and the screen does
   not show it, look at screen wiring and data-ready timing first.
6. **Complete.** `node "$TOOLKIT/scripts/team-tasks.mjs" done <id> --owner
   <your-owner-id> [--evidence <item>]` only after the agreed deliverable and its
   acceptance checks pass. On a task with `accept`, run `jev-ask.ts
   --check-evidence --summary <text> --task <id> --by <your-owner>` as the last
   Jev call, then `done`. When historical reports coexist with current proof, add
   `--phase "merged acceptance" --current-evidence <retained-path>` (repeat the
   flag per receipt, both flags together, exact stored paths from `show <id>`,
   not basenames or original temp paths). Phase and summary are declarations, not
   proof; unselected attachments stay as history; selected receipts take priority
   within the existing caps; an unreadable, guarded, over-cap or out-of-range
   image refuses before any provider call. Each image side must be 280 to 1568
   pixels; resize with `sips -Z 1568`.

   A later `decide`, answered ask, release or reap invalidates that check, and so
   does new evidence: attach every item with `evidence` before the check, not
   with `done --evidence` after it. If one of those lands while the check waits on
   Jev, the board refuses the check and `jev-ask` exits 1; run it again. The latest
   check decides: a rejected or held check after a confirmed one blocks `done`
   again. Repeat `--evidence` for more than one path; a comma stays inside the
   item. `done` keeps `claimedAt`, `heartbeatAt`, the run link and the owner; on an
   already-done task with an owner, `--owner` must match unless `--force`. A gated
   done task cannot take new evidence. The CLI refuses a task that is not claimed
   or is owned by someone else, and does not check dependencies, so verify they
   are complete first. A task with `accept` is refused while `doneBlockers` is not
   empty; `--force` does not skip that. No task finishes while its owner thread is
   open: ask with `ask-owner <id> <question...> --by <your-name>`, keep working on
   what the question does not block, and run `answer-read <id> --by <your-name>`
   once you have read the answer (`inbox` lists it). Never answer your own
   question; the board refuses it. If the task includes integration, the
   coordinator marks it done after integration checks. A review's deliverable
   includes committed and pushed fixes for qualifying findings. Unresolved required
   implementation or verification must not be marked complete as if fixed.
7. **Clean up.** Remove your own worktree, simulator, containers and temp
   resources in the same step that closes the task, enumerating first and
   removing only what your session created. The project's verification skill may
   add steps.

## Route and judgment records

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
under the temp directory is copied beside the board; other paths, URLs and notes
are stored as given. `jev-route.ts --calibrate` reads outcomes before a routing
threshold changes. A lock acquisition error is a coordination failure to report,
not a reason to spin or reset state.

## Project hooks

A project adds its own sections to its copy of this protocol or to its role
skills; keep them out of the toolkit. Typical hooks:

- **Spec preflight.** Test workers write end-to-end specs before the build and
  cannot run them. Before a lane asks for a device or browser slot, a reviewer
  reads the spec next to one with a committed receipt for the same screen and
  confirms with `file:line`: a fresh-environment start passes sign-in and
  onboarding; every asserted or tapped element is on screen at that moment; every
  label, test ID and string exists in the source at the head under test; opt-in
  flags, env var names and seeded data are in the verifier brief; no stale fixed
  dates, no unverified log reads, no sleeps or raised timeouts. A spec fix found
  here is made by a fresh test worker or by the reviewer in place, never by the
  verifier during the slot.
- **Verifier briefs.** Name the head, the spec file, the opt-in flags and the
  lane's ports. A verifier who hits a setup hurdle recovers inside the brief's
  allowed fixes rather than stopping, never asks the owner, reruns a
  timeout-type failure once with no timeout bump, runs specs in the foreground
  one at a time, and posts each pass or fail before starting the next.
- **Device slots.** Slots go bottom of a stacked branch first; one device per team
  while a proof is live; a unit that already lost one slot to a spec bug gets a
  fix-in-hold slot (the verifier keeps the environment up, a fixer edits only the
  spec within 10 minutes, at most two fix loops and 30 minutes); a product bug
  found on the way ends the hold and goes back through tests first.
- **Merge intersection.** Before any merge, intersect the PR's changed files with
  every queued PR and report any overlap to the lead.
