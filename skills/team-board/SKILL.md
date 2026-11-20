---
name: team-board
description: "Operate the shared team task board (team-tasks.mjs): add, claim, heartbeat, evidence, decide, route, done, ask-owner, reviews, archive, doctor and repair. Load when reading or changing board state, or when a board command or healing message needs interpreting."
---

# Team task board

A file-backed task board shared by every worktree of a repository. It is
coordination state, not an agent launcher: it has no execution engine, no
authentication, and a heartbeat only says a worker is alive. Process lives in
[team-coordinator](../team-coordinator/SKILL.md); this skill is the command and
repair reference.

```bash
TOOLKIT="${DEREK_SKILLS:-$HOME/derek-skills}"
node "$TOOLKIT/scripts/team-tasks.mjs" --help
```

The scripts import `arktype` from the toolkit's `node_modules`. On a fresh
checkout run `pnpm install` once in `$TOOLKIT` first; without it the command
fails with `Cannot find package 'arktype'`.

## Where the board lives

`scripts/team-board-path.mjs` resolves it from the **current working directory**:

1. `TEAM_TASKS_FILE` (isolated tests, ad-hoc boards).
2. `<dirname of git common dir>/tasks.json`: the main checkout, shared by all of
   its worktrees. Add `tasks.json*` to the project's `.gitignore`; a board copied
   elsewhere is a different board.
3. `<cwd>/tasks.json` when there is no git.

Retained evidence sits beside it in `tasks.json.artifacts/<task-id>/`; the
archive and the backup (`tasks.json.bak`) sit there too. Extra roles come from
`team-roles.json` beside the board or `TEAM_ROLES_FILE` (see
[roles](../team-coordinator/references/roles.md)).

## Statuses and shape

Statuses: `open`, `claimed`, `done`, `cancelled` (no blocked status: a blocked task
stays claimed and its blocker goes in the handoff). A task carries `role`,
`route`, `owner`, `after` (dependency IDs), `accept`, `tag`, `jev` (latest
verdict), `decisions` (journal), `evidence`, `run`, `claimedAt`, `heartbeatAt`.
Role is the domain owner, route is the executor recommendation, owner is a unique
agent ID. A team or project name is a `--tag`, never a role.

## Commands

`team-tasks.mjs --help` is the authoritative list; the script wins over this page.

Read-only: `list [--all] [--status s] [--role r] [--tag t]` (open and claimed by
default; `--all` expands the archive), `show <id>`, `inbox`, `review-report <id>`,
`view` (the whole board as a kanban renders it), `moves <id>` (per target status,
the command and inputs needed, or the board's refusal), `stale [--hours 24]
[--runs]`, `doctor [--runs]`. The first mutating command creates an absent board.
Never reset an existing one.

Plan: `add <role> <title...> [--after id,id] [--route r] [--accept text] [--tag t]
[--review] [--reason text --by who]`, `jev <id> <json>` (store a verdict),
`route <id> <route> --reason text`, `after <id> <id,id|none>`, `cancel <id>`.

Run: `claim <role> <owner> [--id n] [--run kind:ref] [--wake thread]`,
`heartbeat <id> [--owner o] [--run kind:ref] [--wake thread]`, `lead-wake <thread>
[--task n | --tag t] --by who` (and `--clear`), `evidence <id> [--supporting] <item...>`,
`judgment <id> <json>`, `decide <id> --summary text [--ref path] [--by who]`,
`accept <id> --reason text --by lead`, `done <id> [--owner o] [--evidence item]`,
`release <id>`, `reap --older-than <hours> [--role r] [--include-untimed]`.

Owner thread: `ask-owner <id> <question...> --by who [--packet file.json]`,
`answer <id> <answer...> --by owner`, `note <id> <note...> --by owner`, `note-read
<id> --by lead`, `lead-reply <id> <reply...> --by lead`, `answer-read <id> --by
worker`; `answer` and `note` accept `--expected <review-revision>`. `deliver
[--task id] [--limit n]` sends due outbox records through the optional T3 adapter.

Review: `review <id> findings.json --by owner`, `review-report <id>`.

Upkeep: `archive --older-than-days <n>` or `archive --id <id>`, `doctor --fix`.

## Gating rules worth knowing

- `claim` refuses while a dependency is open; a plain claim never picks route
  `lead_workflow` or `needs_lead`. `claim --id n` takes exactly that task or fails
  and changes nothing.
- A role outside the catalog is refused with an error naming the catalog. A stored
  off-catalog role stays claimable.
- `done` refuses while `doneBlockers` is non-empty (gated tasks), while an owner
  question, unread answer, handed question or note is open, and for a red test
  task. `--force` skips none of these.
- `--by jev` is reserved for Jev verdicts. `--ref` and `--by` are trimmed; blank
  values are refused. `route` needs `--reason` whenever it overrides a verdict or
  a held route.
- A later `decide`, answered ask, release, reap, new acceptance evidence, a note on a done
  task or a review update voids an earlier acceptance check; the next claim needs
  a fresh one.
- `evidence <id> --supporting <path>` retains receipts or handoff material that
  carries no acceptance input. It cannot satisfy or invalidate the acceptance
  gate. For phased checks, `done` revalidates the selected file hashes.
- To require objective Git or GitHub Actions proof, the lead pins the requirement
  at `add ... --git-proof <plan.json>`. The claim owner runs
  `verify-git <id> --by <owner>`. A mixed task also needs a phased Jev check
  tied to that candidate. See the [proof plan fields](../team-coordinator/references/jev-team.md#mechanical-proof).
- A temp-directory path passed to `evidence`, `done --evidence` or `decide --ref`
  is copied beside the board (up to 25 MiB); other paths, URLs and notes are
  stored as given.
- The gate is a protocol gate, not tamper-proof: an agent that edits the board JSON
  gets past it. Never edit live board JSON or delete its lock to recover.

## Board health

The script heals what is provably broken and prints `team-tasks: healed: ...` to
stderr. Read those lines; a repair nobody reads is a hidden change.

- A lock whose owner process is gone (or a legacy lock over 30 seconds old) is
  broken. Temp files left by a crashed writer are removed; a live writer's are not.
- A corrupt `tasks.json` is restored from `tasks.json.bak` by any mutating command
  or `doctor --fix`; the broken file is kept as `tasks.json.corrupt-<time>`. With
  no usable backup it stops and changes nothing, never inventing an empty board.
  Read-only commands do not repair.
- A write that would add a duplicate id or an invalid status is refused. `doctor
  --fix` also reopens a claim with no owner.
- When `doctor` reports `board-size`, the lead runs `archive --older-than-days 7`.
- A done task keeps `claimedAt`, `heartbeatAt`, `run` and owner as provenance; only
  an open or cancelled task loses leftover run fields.
- A claimed task whose `run.at` differs from its `claimedAt` has a stale run;
  `stale` and `doctor` ignore it and the next write drops it. A new claim without
  `--run` deletes any old run. `heartbeat --run` on a claim with no `claimedAt` is
  refused.
- Duplicate string `evidence` entries are removed; `doctor` previews these repairs
  as info findings (`claim-residue`, `duplicate-evidence`) and stays exit 0. A
  refused command prints no `healed:` line and leaves the file unchanged.
- `jev` stores the verdict and stamps `at`. It refuses a done or cancelled task and
  changes the route only when the task is open, the route is not `needs_lead`, no
  lead route decision holds it, and either the route is null with no route decision
  in the journal or still equals the previous verdict's route. Replacing a verdict
  appends `{kind:'jev', verdict}` to `decisions`. Only `route <id> <route>
  --reason` leaves a hold or changes a route a decision is holding.
- Unknown routes, a route differing from its verdict with no route decision and no
  journaled verdict route equal to it, and `roleFits: false` are warnings on open
  and claimed tasks only. `lead`, `sonnet`, `sonnet_subagent` and `""` stay unknown
  routes: writes refuse them, stored values remain valid data.
- `doctor` warns about open tasks waiting on a cancelled task and about stale
  claims. It does not decide whether a worker is alive. `doctor --runs` reads each
  claim's wake thread through the optional T3 adapter (`TEAM_BOARD_T3_BIN`) and
  flags `run-ended` and `run-missing`; run it before reporting a task "in review".
  After confirming the executor stopped, `release <id>`, or `reap --older-than
  <hours>` for many. Claims without timestamps show an unknown age and are skipped
  by `reap` unless `--include-untimed`, because that is what another team's live
  work looks like.
- Run `node "$TOOLKIT/scripts/jev-route.ts" --calibrate` before changing a routing
  threshold.

## Verifying changes to the board

After changing the done gate, the journal, the owner-thread commands, scored
review completion or how Jev judgments are recorded, run the checks in
[verify-team-board](../verify-team-board/SKILL.md).

## Board app (optional)

`apps/board` in the toolkit is a kanban view over the same board: columns, drag to move, an owner thread per
task, and a settings page for the lead's thread. It shells out to `team-tasks.mjs`, so every rule above still
applies; the UI cannot do anything the CLI refuses. Start it from the project checkout (see `AGENTS.md`,
"Using the toolkit in a project"), or set `TEAM_BOARD_PROJECT` to that checkout: it is where the board file
defaults to (`tasks.json`, unless `TEAM_TASKS_FILE` names another) and the T3 project whose threads the lead
picker lists. It defaults to the working directory. Browser checks: `pnpm --filter @derek-skills/board test:browser`; they are time-sensitive
and flake on a loaded host, so rerun a failing spec alone before treating it as a regression.
