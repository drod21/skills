# Board health

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
