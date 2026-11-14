---
name: team-coordinator
description: Coordinate area leads and their workers through a chief of staff, one owner review queue, Jev routing, evidence, and learned preferences on a shared task board. Load before team dispatch, delegation, or team-board work in any repository.
---

# Team coordinator

Project-agnostic. A repository supplies its own task map, command skill, role
skills and owner preferences; this skill supplies the process.

## Locating the toolkit

Every command below runs a script from this toolkit, never from the project:

```bash
TOOLKIT="${DEREK_SKILLS:-$HOME/derek-skills}"
node "$TOOLKIT/scripts/team-tasks.mjs" list
```

Run scripts from inside the project checkout: the board file is found from the
current directory (see [team-board](../team-board/SKILL.md)). Use Node 22.18+
for every `.ts` script, not Bun. Give every worker the absolute script paths.

## Standing team cycle

Read the [operating cycle](references/operating-cycle.md) before planning or
resuming a team cycle, and [owner preferences](references/owner-preferences.md)
before preparing work or a recommendation. One standing lead owns each active
focus area; the chief of staff ([chief-of-staff](../chief-of-staff/SKILL.md))
coordinates those leads and is the single human-facing intake. Leads manage
implementation, testing, review follow-through and integration through bounded
workers. Loading this skill starts no service. Use the
[review queue](references/review-queue.md) for `ask-owner --packet`, retained
screenshots and video, priority buckets and revision-bound owner decisions.

The board is coordination state, not an agent launcher. Read
`$TOOLKIT/scripts/team-tasks.mjs`, `jev-route.lib.ts`, `jev-executors.lib.ts` and
[Jev decisions](references/jev-decisions.md) before dispatch: their current
behavior wins over this guide.

## Decision and escalation chain

Use **worker -> Jev -> area lead -> chief of staff -> human queue** for
unresolved judgments. This is agent guidance, not board enforcement: board
commands neither call Jev nor authenticate the decision maker.

1. Resolve exact facts from authorized instructions, source and measurements
   first. Do lookups, counts, math and code checks directly; never turn them into
   model authority or re-ask about authorized work.
2. When a remaining decision needs semantic judgment, the worker consults Jev
   **before asking the lead**: `jev-route.ts` for task routing, `jev-decide.ts` for
   implementation or fix options, `jev-ask.ts` for yes/no, pick and preset
   questions. Make one bounded live attempt when configured; retain the input,
   result and exit/error evidence ([Jev decisions](references/jev-decisions.md)).
   A missing key, unavailable service or API error goes to the lead honestly. Do
   not fabricate a verdict or retry indefinitely. A dry run is not a consultation.
3. A worker may follow a sound, confident recommendation with no unresolved holds
   **inside the already authorized scope**. Verify its factual assumptions, run
   the required checks, record the choice with `decide <id> --summary "..." --ref
   <artifact> --by <actual-worker-owner>` and attach evidence. Jev supplies
   judgment, never permission or test truth.
4. For `needs_lead`, holds, option-order flips, uncertainty, conflicting evidence
   or missing material scope or authority, send the parent lead one narrow
   question: the Jev input/result (or unavailability evidence), concrete options,
   a recommendation and the blocker. Cross-domain decisions, new dependencies and
   file collisions also go to the lead. Children never call user-question tools;
   they hand the question to their parent. Workers cannot clear route holds; the
   lead uses `route <id> <route> --reason "..."` and records their real identity.
5. The area lead answers from the user's instructions and evidence and handles
   work within existing authority. Cross-area conflicts go to the chief of staff.
   Only the chief of staff asks the human, through the queue, and only when
   missing information, a decision or permission materially requires the human.
   Include context and a recommendation; skip questions source can answer.
   Record a lead option decision with `decide --by <actual-lead-owner>`.

Never consult Jev to override user or developer instructions, safety rules or
tool approvals. The actual tool-approval holder still controls approval.

## Plan and route

1. Identify the checkout, dirty work, allowed edits, acceptance evidence and
   dependencies. Give parallel writers disjoint file ownership; serialize
   shared-file edits or use isolated worktrees with an explicit integration owner.
2. Choose a role from [roles](references/roles.md). **Role** is the domain owner,
   **route** is the executor recommendation, **owner** is a unique agent ID. A
   role is not a model, and a skill supplies instructions without creating an agent.
3. Inspect the board with `list`, `show <id>`, `stale` or `doctor` (none writes).
   Never reset an existing board. Worktrees share the main checkout's
   `tasks.json`, which is gitignored; a copied board is a different board.
4. When Jev is configured, judge a task (Node 22.18+, needs `TYPESAFE_API_KEY`,
   calls an external service, so keep keys and private artifacts out of titles
   and briefs):

   ```bash
   node "$TOOLKIT/scripts/jev-route.ts" 'Concrete task and acceptance criterion' \
     --role backend-worker --brief 'Allowed: src/x.ts. Acceptance: x.test.ts passes.'
   ```

   Jev judges scope, subtlety, mechanical fit, risk, open decision, owner and
   proof; code maps scope and subtlety to a route, then picks an executor within
   it. Inspect `holds`, `roleFits`, `suggestedRole`, `check` and `reasons`, not
   only `route`. `--add` adds the task under Jev's suggested role when Jev is
   confident the submitted role does not fit. `--task <id>` reads title, role and
   `after` from the board and stores the verdict (do not pass a title, `--role` or
   `--after` with it; `--brief` is fine). It refuses a done or cancelled task and
   does not lift `needs_lead` or replace a route a lead set. A missing key or
   service is an unavailable check, not permission to invent a result.
5. Add ready tasks with their approved role and route, using returned IDs for
   dependencies, title before flags:

   ```bash
   node "$TOOLKIT/scripts/team-tasks.mjs" add backend-worker 'Implement the agreed fix' \
     --route terra_patch --accept 'The focused suite passes.'
   node "$TOOLKIT/scripts/team-tasks.mjs" add qa-worker 'Verify the fix' --after 1 \
     --route haiku_fork --accept 'The suite passes and the screenshot shows the label.'
   ```

   Every role except `lead` needs `--accept` (at most 600 characters). `--tag <t>`
   is an optional team label (lowercase letters, digits, hyphens). A team or
   project name is a tag, never a role. Never dispatch `needs_lead` or unresolved
   holds. Resolve a hold with `route <id> <route> --reason "..."` once decided.
   Re-plan a task blocked by a cancelled dependency with `after <id> <id,id|none>`.
   There is no block command, and never bypass a hold by adding a duplicate.

## Tests first

Tests are written up front from the lead's plan by a lightweight worker, builders
build against them, and builders never touch them. The aim is no time spent
fixing tests after the build.

1. **Plan.** Each unit's behavior is stated as checkable acceptance cases: inputs,
   expected observable result, and the level each one lives at (unit or table
   test, real-database test, end-to-end test for wiring and timing). A unit the
   lead cannot state this way is not ready to dispatch.
2. **Test task.** Add a test task per unit ahead of the build task, routed to the
   lightest executor that can carry it. Its brief is the acceptance cases plus
   the allowed test and minimal-contract paths, nothing about how to build. The
   test worker writes the tests and only the contract they need to compile
   (types, signatures, a module that throws "not implemented"), commits them as
   the unit branch's first commit, and returns the SHA, the locked test files,
   the run command, and a red run showing each test fails for its stated reason
   rather than on an import or setup error. A skipped test is not red, so the
   red run reports zero skips. Dispatch only after the owner decisions the cases
   depend on are answered.
3. **Build task.** Add it with `--after <test task id>`. `claim` refuses while the
   test task is open and `done` refuses a red test task even with `--force`. When
   the red run returns, record the baseline with `decide <test id> --summary
   <SHA and red result> --by <lead>`, release the builder with `after <build id>
   none`, then dispatch. Close the test task with the builder's green run. The
   build brief names the test commit, the locked files and the run command, and
   says: make these pass; do not edit, skip, delete, loosen or re-time a locked
   file. A builder may add tests in new files. A builder who believes a locked
   test is wrong stops that part, reports the test, reason and evidence to the
   lead, and continues with the rest.
4. **Wrong test.** The lead decides. If the test is wrong or the plan changed, a
   fresh test worker amends it in its own commit and the lead sends the builder
   the new SHA. The builder never makes that edit.
5. **Gate.** Before review, the lead (or the reviewer, as its first check) runs
   `git log -p <test commit>..<head> -- <locked files>` and checks each change
   against the lead's assigned test-worker commits, including edits later
   reverted; author names alone are not proof. Any other change is blocking,
   whatever the suite says.

This covers behavior tests. Screenshots, device runs and other runtime evidence
stay with the builder and the QA worker. Skip the test task only for
documentation-only changes, specs, investigations and throwaway prototypes, and
say so in the task.

## Dispatch and finish

Use the harness's live capability catalog to select an available executor; route
labels such as `terra_patch` are hints, not provider or model IDs. Honor an
explicit user model choice. If it is unavailable, report that rather than
silently substituting. Use the harness's delegation tool (a delegate-task tool,
Claude Code `Agent`, Codex `spawn_agent`) with worktree isolation when requested
or needed, and retain the returned task or thread ID. Do not launch top-level
conversations for delegated work, and do not create agents merely to fill roles.

Dispatch a large wave a few builders at a time. Start the next step only after the
current step's installs and simulator or emulator boots finish and `uptime` load
is back under the project's load guard: a burst of parallel installs stalls every
agent on the host. Claude Code runs at most 20 native subagents at once and a
launch over the limit fails for good; split larger fan-outs into waves of 20 or
fewer and queue the rest.

Route every new delegate through Jev: implementation, fix rounds, reviews and
re-checks alike. A route is a capability tier; the verdict's `executor` is the
model that carries it. Before each delegation:

1. Write the live catalog's runnable pairs to a file under the scratch directory:
   a JSON list of `"providerInstanceId:model"` strings, or the capability rows
   themselves (a row with `canRun: false` offers nothing). Refresh after an error.
2. Run `node "$TOOLKIT/scripts/jev-route.ts" '<task>' --role <role> --brief
   '<allowed files; acceptance>' --available <file>` (or `--task <id>`). Add
   `--unavailable <providerInstanceId[:model]>` (repeatable) for a known outage.
   Without `--available`, every registry executor counts, so never omit it for
   real dispatch.
3. Save the printed verdict and cite it in the brief. Dispatch the verdict's
   `executor` (`providerInstanceId`, `model`, `options` as printed). The board
   stores it on the task's `jev` verdict.

The route is the board task's current `route` (a lead `route <id> <route>
--reason` decision stands over a newer verdict), otherwise the verdict's `route`.
When a lead decision changed the route, the verdict's `executor` is for the old
route: take the first entry of the new route's list in `jev-executors.catalog.mjs`
that the catalog offers, and record the choice. An explicit user model choice
overrides both. Never pick by preference or by which provider happens to be up.

`jev-executors.catalog.mjs` is the registry: an ordered list of executors per
route, the first being the tier default. Each entry carries facts only (family,
list price, a code-specialized name), no quality ranking. After the route is
decided, Jev picks among the available entries and its pick stands only at
`minExecutorConfidence` or above; otherwise the first available entry stands
(`source: "default"`). `executor: null` means the tier has nothing available or
the route is held or scripted. For a route outside the registry's tiers, the lead
picks one catalog pair and records it in the brief.

A `needs_lead` verdict or hold stays with the lead. A retained author that
continues its own work keeps its model. When the routed executor is unavailable or
cannot start a turn, report it to the lead rather than substituting; the lead
picks the replacement and records why (`route <id> <route> --reason` on a board
task, the brief otherwise). When an owner rule makes you override the same route
twice, change that tier's default in the catalog and its test instead of
overriding task by task. Before treating a delegate's completion notice as final,
check for pending child runs (a notice can be interim while a background command
or child review still runs) and read its thread, then send one in-thread message
answering any question it left.

Brief delegates by absolute path to the [worker protocol](references/worker-protocol.md)
and the role skill. A rule learned mid-session goes into the repo skill in that
session, never only into a scratch copy of the protocol; this includes owner
rules held in the lead's memory: copy each applicable one into the brief or the
repo skill at dispatch. Every "never X" in a brief names the allowed "do Y" in the
same sentence.

An isolated worktree starts from the parent commit without uncommitted skill or
routing edits. Before dispatch, make sure the child has the required revision and
role skills, or give an accessible absolute skill path. Keep claims on the
designated coordinator board regardless. For a pinned review, resolve the
candidate SHA and verify that the assigned checkout's `HEAD` matches it exactly.

Give each worker: task title and ID, role skill, absolute board script,
checkout and head, allowed files, dependencies, acceptance checks and expected
evidence. Workers follow the [worker protocol](references/worker-protocol.md).
A plain `claim <role> <owner>` returns the first eligible task for the role, which
on a shared board can be another team's task. The lead claims the assigned task
for the worker with `claim <role> <owner> --id <id>`, which takes exactly that
task or fails with the reason. A plain claim never picks route `lead_workflow`;
claim that with `--id <id> --run workflow:<runId>`.

Wake addressing: at session start the top lead obtains its thread ID and runs
`lead-wake <thread> --by <lead>`. Only the top lead sets `lead-wake <thread> --tag
<team-tag> --by <lead>`. An area lead runs `lead-wake <thread> --task <id> --by
<lead>` per task, because a tag holds one address and a bare `lead-wake <thread>`
overwrites the global wake. Immediately after a delegation returns, run
`heartbeat <id> --owner <owner> --wake <childThreadId>`. Workers pass
`--run <kind>:<ref>` on claim (`workflow`, `t3_task`, `subagent` or `session`).

On a task with `accept`, workers ask Jev themselves with `jev-ask.ts --task <id>
--by <owner>` (`--preset flaky_or_real|blocker_or_nit|clipped_text`, `--pick` for a
two-to-four label choice) and `jev-decide.ts --task <id> --by <owner>` for scored
options; `jev-ask.ts --check-evidence` is the last Jev call before `done`. The
lead resolves a hold with `decide` and uses `accept <id> --reason <text> --by
<lead>` only when that check holds. `done` refuses while `doneBlockers` is not
empty and `--force` does not skip it. The gate is a protocol gate, not a
tamper-proof one. Nothing secret goes to Jev: credential files are never read,
token-shaped text is refused, and at most 12 evidence items (4 images, each side
280 to 1568 pixels) are sent; resize with `sips -Z 1568`.

A question only the owner can answer goes on the task, not into chat: `ask-owner
<id> <question...> --by <name>` on a claimed task, one open at a time; file each
named owner decision of an accepted plan with `ask-owner --packet`. The owner
replies with `answer`, or hands it to the lead with `note`. The lead marks a note
read with `note-read`, answers with `lead-reply <id> <reply...> --by <lead>` (which
starts no turn; follow it with a message to the lead's worker), and the worker
acknowledges with `answer-read`. `inbox` lists who owes the next move: check it at
the start of every lead turn. `done` refuses while a question, unread answer,
handed question or note is open. Only the owner answers, and `answer --by` must
differ from the claim owner and the asker. If the owner answers in chat, that is
the answer: record it with `decide <id> --summary --ref <chat>` and go on.

Track both agent status and board status. A failed or cancelled worker leaves its
claim intact. To replace one, confirm the old executor stopped, pause board users,
inspect retained edits and artifacts, and change only the claimed task's owner,
preserving ID, dependencies, route, status, `run`, `jev`, `decisions` and
`evidence`; record old and new owner, failure and retained artifacts in the
handoff. Stop your own background work by task ID, never with a command-pattern
`pkill`, because delegates run identical command lines. Keep blocked work
unfinished and report its owner and blocker; never use `done` to unblock
dependents without passing acceptance. If the verification surface cannot reach
a ticket's acceptance path, a PASS plus an "Owed" line is not acceptance: add a
fixture that fakes that state, or keep the task open on a device gate. Once
outputs are integrated, inspect the combined diff and run affected checks. Report
source, synthetic, replay, runtime, physical-device and external-delivery
evidence separately. A green board is not proof of deployment or release.

## Review instructions

Nothing is held up in review: the reviewer already has the diff loaded, so the
reviewer fixes what it finds. A review ends with the fixes committed and pushed
and a PASS at the head the reviewer pushed, not a list of findings for someone
else. A review may end without a PASS only for something the reviewer cannot
settle in the diff: an owner decision, a missing credential or approval, or a
change outside the pull request's scope. It then fixes everything else first and
names that one item. Never write a read-only review brief.

Reviewers and adversaries review the pinned diff and directly fix qualifying
issues within their assigned file ownership. Do not assign them test execution,
including after their fixes or on re-checks. They may inspect test source and add
tests in new files; locked tests change only through a test worker, and their
first check is the tests-first gate. Assign test execution to a separate test
worker or CI, in parallel with adversaries when safe or after review and before
merge. The coordinator ensures required checks cover the final integrated
revision (earlier results do not validate later edits); a designated fixer owns
test and CI failures and integration conflicts. Give parallel adversaries
disjoint writable files or isolated checkouts with an integration owner.

Use [PR reviews across harnesses](references/pr-reviews.md) for worktree setup,
call-site and test helpers, advisor checkpoints and the review/fix boundary. It
applies to every re-check. Create every review board task with `add ... --review`:
the board then requires a scored review (`{ "findings": [] }` for a clean one),
refuses completion over pending or blocked findings, and records the report.
Submit with `review <id> <findings.json> --by <claim-owner>` and read unfixed
findings with `review-report <id>` ([execution tools](references/jev-execution.md)).

Include these three instructions in every reviewer brief, re-checks too:

1. **Score every comment.** State the concrete conditions under which the issue
   occurs, occurrence frequency 0-10 and impact 1-10, with evidence and a
   rationale for both. If occurrence conditions cannot be specified, assign
   **frequency 0**; never invent a scenario or inflate frequency to justify a fix.
2. **Cross-check with Jev.** Verify factual claims against source and observed
   behavior, then use `jev-ask.ts` for a bounded judgment or `jev-decide.ts` for
   fix options. Include the conditions, scores, rationale and non-secret
   evidence. Retain the input and result or unavailability evidence and resolve
   disagreements through the escalation chain. Jev does not replace the
   reviewer's scores, factual checks or the fix threshold.
3. **Apply the fix threshold and report everything deferred.** Fix an issue only
   when **frequency x impact >= 20**, or **frequency >= 1 and impact >= 8**.
   Leave every other issue unfixed, including frequency-0 comments, on every
   round: repeatedly fixing unlikely issues prevents convergence. In the
   completion report list every unfixed comment with its conditions (or
   explicitly unspecified), frequency, impact, product, Jev cross-check result
   or unavailability, and why it remains unfixed. State when there are none;
   report any qualifying issue that stays blocked separately with owner and blocker.

## Jev cross-checks during execution and handoff

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
  and recent actions. When an action repeats without progress or Jev is unsure,
  inspect the state and return the judgment to the lead. Jev's choice never
  authorizes an external action.
- **Select context before summarizing, filter large evidence, batch related
  judgments.** Use `jev-select.ts` (filter or compact) and `jev-batch.ts`; they
  retain complete bounded inputs and split requests instead of tail-truncating.
  Semantic content judgments are editorial evidence, not measured rankings.

Details and input formats: [execution tools](references/jev-execution.md).

## Board health and verification

Board repair rules, `doctor`, `stale`, `reap` and archive behavior live in
[team-board](../team-board/SKILL.md). After changing the done gate, the journal
or how Jev judgments are recorded, run [verify-team-board](../verify-team-board/SKILL.md).
