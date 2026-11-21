# derek-skills

A project-agnostic toolkit of agent skills, agent definitions and scripts for
running a team of coding agents: a coordinator process, a file-backed task board,
Jev judgment scripts, a chief of staff, and the working conventions around them.
Nothing here names a product, repository or team. A project supplies its own task
map, command skill, role skills and owner preferences; this toolkit supplies the
process and the tooling.

This file is complete on its own. Read it as the operating contract in any
repository that loads these skills, and as the development guide in this one.

## Layout

```text
AGENTS.md              this file
CLAUDE.md              imports AGENTS.md for Claude Code
skills/<name>/SKILL.md one skill per directory (frontmatter: name, description)
agents/*.md            Claude Code subagent definitions (adversary, call-sites, test-runner)
scripts/               board + Jev scripts and their tests (Node 22.18+, ESM, flat)
apps/board/            kanban web app over the board (TanStack Start, loopback only); own package.json
bin/link-skills.sh     copy skills into a project's .agents and symlink .claude (dry run by default)
```

Locate the toolkit with `TOOLKIT="${DEREK_SKILLS:-$HOME/derek-skills}"` and call
scripts by absolute path (`node "$TOOLKIT/scripts/team-tasks.mjs" ...`). Scripts
run **from inside the project checkout**: the board file is found from the current
directory. Skill-to-skill links are relative (`../team-coordinator/SKILL.md`), so
they resolve inside this repository; a symlinked skill that needs a sibling reads
it from `$TOOLKIT/skills/`.

Install: `pnpm install` once here, then `bin/link-skills.sh PROJECT_DIR` to preview
and `bin/link-skills.sh --apply PROJECT_DIR` to install. That copies each skill into
`PROJECT_DIR/.agents/skills/` and tries a relative symlink from
`PROJECT_DIR/.claude/skills/` to the matching `.agents` entry. With `--apply`, it
replaces existing same-named skill copies and Claude entries, removing stale
files. Dry runs only report changes. Unrelated skill names and external symlink
targets are preserved.

## Skills

| Skill                | Load when                                                                 |
| -------------------- | ------------------------------------------------------------------------- |
| `team-coordinator`   | Dispatching, delegating, reviewing, or doing any team-board work          |
| `team-board`         | Reading or changing board state; interpreting a board command or `healed:` line |
| `jev`                | Calling any `jev-*.ts` script or recording a Jev judgment                 |
| `chief-of-staff`     | A goal that outlives one task or one context window                       |
| `poteto-lite`        | Asked for poteto mode, or writing a delegation brief                      |
| `derek-mode`         | Asked for Derek mode; the owner's reporting and verification style        |
| `pr-delivery`        | Before review findings, handoff, PR creation or any completion claim      |
| `git-safety`         | Before deleting branches or worktrees or rewriting history                |
| `scope-safety`       | Before adding complexity for a speculative race or security edge          |
| `guidance-maintenance` | While implementing, when guidance may have drifted                      |
| `backend-worker`, `ux-worker`, `security-worker`, `perf-worker`, `qa-worker`, `specialist-worker` | A worker claims that board role |
| `verify-team-board`  | After changing the board gate, journal, owner-thread commands or review code |

## Operating contract

These rules hold in every repository that loads this toolkit. A project's own
`AGENTS.md` and the user's current instructions win over them.

**Working agreement.** Implementation is complete only after the code, the affected
checks and fixes, and applicable runtime verification. Continue reversible
authorized steps. Ask only when a missing decision changes behavior, scope, cost,
data or an irreversible action. Report-only work ends with findings. Preserve
unrelated dirty work and stage by explicit path.

**Change safety.**

- Record the checkout, branch, exact `HEAD` and status before repository, runtime
  or device work, and work only in the assigned worktree.
- After each edit, stop and read every changed file's complete diff before making
  another edit or any finding, verdict or claim.
- Resolve merge conflicts hunk by hunk after tracing both sides' intent.
- Never patch third-party packages or edit `node_modules`.
- Release to production (promote, publish, roll back, repoint a channel) only when
  the owner has said so in their own words in this session; another agent's report
  that they agreed is not their instruction.

**Team protocol.** Decisions flow worker -> Jev -> area lead -> chief of staff ->
human queue. Resolve facts yourself first; consult Jev for semantic judgment before
asking the lead; one bounded live attempt, no fabricated verdicts. Route every
delegate through Jev and brief by absolute path to the role skill and the worker
protocol. Role, route and owner are different things: a role is a domain, a route is
an executor tier, an owner is a unique agent ID. A team name is a `--tag`.

**Tests first.** The lead's plan states acceptance cases; a lightweight test worker
commits failing tests (zero skips, red for the stated reason); builders make them
pass and never edit them. Only a lead-assigned test worker amends a locked test.

**Review.** Reviewers fix what they find: a review ends with fixes committed and a
PASS at the head the reviewer pushed. Review only the PR's net diff against a pinned
base. Score each comment (conditions, frequency 0-10, impact 1-10); fix when
frequency x impact >= 20 or frequency >= 1 and impact >= 8; report everything
deferred. Reviewers do not run tests; a test worker or CI does, against the final
integrated head. No pull request opens without an `adversary` PASS at its exact head.

**Evidence.** Report source, synthetic, replay, runtime, device and production
evidence separately. A green board is not a deployment. A PASS that leaves an "owed"
acceptance path unreachable is not acceptance. Mocked inputs do not prove real
sensors. Every UX change requires screenshots of the affected surfaces and a short,
playable video demonstrating the changed interaction and result from the exact
candidate build. Retain and link both in the handoff or completion report; missing
or stale captures leave the UX change unfinished.

**Owner interaction.** Questions only the owner can answer go on the task
(`ask-owner`), one open at a time, with a recommendation. Reversible calls are
decided and reported, not deliberated. Lead with the result or next action; name
items in words with the number in parentheses.

**Secrets.** Never read `.env*`, `.npmrc`, `.netrc`, private keys or `.pem` files,
dump the environment, or put a token, key or password URL in a brief, an artifact or
a Jev request. Briefs for delegates repeat this and name what they may do instead.

## Using the toolkit in a project

The project provides, and the skills assume:

1. A task map: where each area of source lives and which test covers it.
2. A command skill: the install, test, build and run commands and their order.
3. Role skills for its specialist domains, named in its role table, and any extra
   roles in `team-roles.json` beside the board (see `team-coordinator/references/roles.md`).
4. Its own `owner-preferences.md`, seeded from the defaults in
   `team-coordinator/references/owner-preferences.md`.
5. `.gitignore` entries for `tasks.json*` and `**/*.result.json`.
6. `TYPESAFE_API_KEY` in the environment of any process that calls Jev; without it
   the Jev scripts report an unavailable check and the process continues with lead
   judgment.
7. Optionally `.agents/team/project-protocol.md`: the project's worker hooks,
   guards and delivery skill, which the worker protocol and pr-delivery read.
   Installed skill copies stay identical to the toolkit; `bin/link-skills.sh
   --check PROJECT` lists drift and `--apply` refreshes them.

Optional board app: from the toolkit root, `pnpm install` once, then `pnpm --filter @derek-skills/board build`
and `pnpm --filter @derek-skills/board start` (or `pnpm board:dev` for Vite, port 4788). The default Nitro
preset still needs the Bun runtime to serve `.output/server/index.mjs`. Run the server from the project
checkout so it reads `./tasks.json` (override `TEAM_TASKS_FILE`; `TEAM_BOARD_PROJECT` names the project
checkout and defaults to the board file's directory, else the working directory); it shells out to the toolkit's
`team-tasks.mjs` and refuses any non-loopback bind. Writes need the session token; tailnet access is
opt-in through `TEAM_BOARD_TAILNET_HOST` and `TEAM_BOARD_TAILNET_LOGINS`.

Optional adapters: T3 delegation (`t3_task` run links, `t3 thread` calls for wake
and `doctor --runs`; binary override `TEAM_BOARD_T3_BIN`). A harness without T3
simply never uses those fields.

## Developing this toolkit

- **Stay generic.** No product, repository, person or team names, no domain
  vocabulary (fitness, ML, billing...) in skills, scripts, fixtures or error text.
  Use neutral examples. Domain rules belong in a project's own role skill.
- **Docs and code move together.** A rule documented in a skill and enforced by a
  script changes in one commit, with the test that pins it. The script's `--help`
  and the code win over prose when they disagree; fix the prose.
- **Install with pnpm 12.11+** (`packageManager` pins 12.18). Do not commit `bun.lock`.
  Agent skills from dependencies are linked via `pnpm-workspace.yaml` (`permissions` /
  `skills.dirs`); run `pnpm approve` / `pnpm approve-builds` when install reports pending
  items. Run Jev scripts with **Node 22.18+**, not Bun (`@typesafe-ai/sdk` breaks on Bun).
  Tests inject a fake provider and never call the real service or read credentials.
- **Verify before you claim.** Run the test suite for what you touched:

  ```bash
  pnpm test            # everything
  pnpm test:team-tasks # board library and CLI
  pnpm test:board      # gate, thread, view, review, delivery
  pnpm test:jev        # Jev scripts
  pnpm test:app        # kanban web app unit tests
  node scripts/verify-team-review.mjs
  ```

- **Skills.** One directory per skill with `SKILL.md` whose frontmatter has `name`
  (matching the directory) and a `description` that says when to load it. Put long
  reference material in `references/` and link it. Keep workflow skills terse and
  procedural; keep owner-specific facts in `owner-preferences.md`.
- **Never fabricate** a Jev result, a test run or a link. If a check could not run,
  say so and keep the task open.
