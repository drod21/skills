# Dispatch and finish

Use the harness's live capability catalog to select an available executor; route
labels such as `opus_patch` are hints, not provider or model IDs. Honor an
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
decided, the first available entry carries it (`source: "default"`); there is no
second Jev call, and later entries are only outage fallbacks. A stored
`source: "jev"` is from an older verdict. `executor: null` means the tier has nothing available or
the route is held or scripted. For a route outside the registry's tiers, the lead
picks one catalog pair and records it in the brief.

## Model roles

Each model has one job. Jev's table covers the patch tiers; the lead picks the
pair for the other rows and records it in the brief.

| Job | Route | Default pair |
| --- | --- | --- |
| Lead: spec, split, the hardest slice | lead, `claude_design`, `fable_patch` | `claudeAgent_2:claude-fable-5-2` |
| Builder: a subtle slice in its own worktree | `opus_patch` | `claudeAgent_2:claude-opus-5-5` |
| Code workhorse: ordinary slices, in waves | `sonnet_patch` | `claudeAgent_2:claude-sonnet-5-5` |
| Chores: one file, mechanical work | `haiku_fork`, `luna_patch` | `claudeAgent_2:claude-haiku-5-5`, `codex:gpt-6-luna` |
| Fast spec draft from an agreed goal | `codex_design` | `codex:gpt-6.2-sol` (`reasoningEffort: high`) |
| Second opinion from another family | `gemini_review` | `cursor:gemini-4-argon` |
| Playtester: break the candidate build | `codex_audit` | `codex:gpt-6.2-astra` (`reasoningEffort: high`) |
| Copywriter: docs, changelog, UI copy | `gemini_patch` | `cursor:gemini-4-neon` |

Codex 6.2 models default to low effort; always pass `reasoningEffort: high`.
Fable costs twice Opus, so it takes only subtle cross-package work and the
lead's own spec and split.

- **Opus builders:** one slice per builder. Run several builders at once, each in
  its own worktree with disjoint files; never hand one builder two slices.
- **Sonnet waves:** dispatch `sonnet_patch` tasks two or more at a time, never one
  alone. When only one is ready, hold it until a second `sonnet_patch` task is
  ready in the same plan; if none is coming, re-route it to `opus_patch` with
  `route <id> opus_patch --reason "lone sonnet slice" --by <lead>`.
- `grok_patch` and `terra_patch` are no longer emitted. Their tiers stay so
  stored verdicts and earlier lead overrides still match.

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

Brief delegates by absolute path to the [worker protocol](worker-protocol.md)
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

Start every brief from `team-tasks.mjs brief <id> --kind <test|build|review|verify>` (build waiver: `--no-test-pair --reason "<text>"`),
which fills the board fields and leaves the rest as `<slots>`. Give each worker: task title and ID, role skill, absolute board script,
checkout and head, allowed files, dependencies, acceptance checks, expected
evidence, and a **Guards** line copied from the project's instructions (how files
may be written, the load guard, banned commands), so a project hook never refuses
work the brief asked for. Every test and build brief says: branch from `origin/main` (a builder
from its test commit on that branch); carry another packet's commits only when
the plan names that dependency. Workers follow the [worker protocol](worker-protocol.md).
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
options; `jev-ask.ts --check-evidence` is the last Jev call before `done`. Before
invoking a bounded wrapper that writes results, create and verify its task-owned
output directory. Helper subagents pass `--out <dir>` and do not write the board.
The lead resolves a hold with `decide` and uses `accept <id> --reason <text> --by
<lead>` only when that check holds. `done` refuses while `doneBlockers` is not
empty and `--force` does not skip it. On a gated task, only the claim owner
records a judgment. The gate is a protocol gate, not a tamper-proof one. Nothing
secret goes to Jev: credential files are never read, token-shaped text is refused,
and at most 12 evidence items (4 images, each side 280 to 1568 pixels) are sent;
resize with `sips -Z 1568`.

A question only the owner can answer goes on the task, not into chat: `ask-owner
<id> <question...> --by <name>` on a claimed task, one open at a time; file each
named owner decision of an accepted plan with `ask-owner --packet`. The owner
replies with `answer`, or hands it to the lead with `note`. The lead marks a note
read with `note-read`, answers with `lead-reply <id> <reply...> --by <lead>` (which
starts no turn; follow it with a message to the lead's worker), and the worker
acknowledges with `answer-read`. `inbox` lists who owes the next move: check it at
the start of every lead turn. `done` refuses while a question, unread answer,
handed question or note is open. `cancel` refuses while the owner's note is
unread, and `archive` keeps a task whose note is unanswered. Only the owner
answers, and `answer --by` must differ from the claim owner and the asker. A note
that reopens a finished task voids every earlier judgment, like a release, so the
next claim needs a fresh check. If the owner answers in chat, that is the answer:
record it with `decide <id> --summary --ref <chat>` and go on.

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
