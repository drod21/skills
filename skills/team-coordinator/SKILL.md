---
name: team-coordinator
description: Coordinate leads and workers on a shared task board with Jev routing, tests first, scored reviews and evidence. Load before team dispatch, delegation or board work in any repository.
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

One standing lead owns each active focus area; the chief of staff
([chief-of-staff](../chief-of-staff/SKILL.md)) coordinates those leads and is the
single human-facing intake. Leads manage implementation, testing, review
follow-through and integration through bounded workers. Loading this skill starts
no service. The board is coordination state, not an agent launcher.
`team-tasks.mjs help <command>` and `jev-route.ts --help` describe current
behavior, and current behavior wins over this guide.

## Decision and escalation chain

Unresolved judgments go **worker -> Jev -> area lead -> chief of staff -> human
queue**, after exact facts are resolved from instructions, source and
measurements. Jev supplies judgment, never permission or test truth, and never
overrides user or developer instructions, safety rules or tool approvals. The
full chain, who records what, and the commands:
[decision and escalation chain](references/jev-decisions.md#decision-and-escalation-chain).

## Rules that always apply

- Route every new delegate through Jev with `--available`, and dispatch the
  verdict's executor ([dispatch](references/dispatch.md)).
- Behavior tests come in parallel from a lightweight test worker; builders never edit
  them ([tests first](references/tests-first.md)). Tests are built, feature or bug fix is built, and the reviewer runs both and fixes issues.
- Every reviewer brief carries the three scoring instructions, and reviewers fix
  what they find ([review instructions](references/pr-reviews.md#review-instructions)).
- Brief workers by absolute path to the [worker protocol](references/worker-protocol.md)
  and the role skill, with a **Guards** line from the project's instructions.
- A green board is not proof of deployment or release.

## Plan and route

1. Identify the checkout, dirty work, allowed edits, acceptance evidence and
   dependencies. Give parallel writers disjoint file ownership; serialize
   shared-file edits or use isolated worktrees with an explicit integration owner.
2. Choose a role from [roles](references/roles.md). **Role** is the domain owner,
   **route** is the executor recommendation, **owner** is a unique agent ID. A
   role is not a model, and a skill supplies instructions without creating an agent.
3. Inspect the board with `list`, `show <id>`, `stale` or `doctor` (none writes).
   Filters are `--status`, `--role` and `--tag`. The first mutating command creates
   an absent board. Never reset an existing board. Worktrees share the main
   checkout's `tasks.json`, which is gitignored; a copied board is a different
   board.
4. When Jev is configured, judge a task (Node 22.18+, needs `TYPESAFE_API_KEY`,
   calls an external service, so keep keys and private artifacts out of titles
   and briefs):

   ```bash
   node "$TOOLKIT/scripts/jev-route.ts" 'Concrete task and acceptance criterion' \
     --role backend-worker --brief 'Allowed: src/x.ts. Acceptance: x.test.ts passes.'
   ```

   Jev judges scope, subtlety, mechanical fit, risk, open decision, owner and
   proof; code maps scope and subtlety to a route, then takes the route's first
   available executor (no second Jev call). An uncertain score widens the executor instead of holding, so `needs_lead`
   means a `risky` or `needs_decision` hold. Inspect `holds`, `roleFits`,
   `suggestedRole`, `check` and `reasons`, not only `route`. `--add` adds the
   task under Jev's suggested role when Jev is confident the submitted role does
   not fit. `--task <id>` reads title, role and `after` from the board and stores
   the verdict (do not pass a title, `--role` or `--after` with it; `--brief` is
   fine). It refuses a done or cancelled task and does not lift `needs_lead` or
   replace a route a lead set. A missing key or service is an unavailable check,
   not permission to invent a result.
5. Add ready tasks with their approved role and route, using returned IDs for
   dependencies, title before flags:

   ```bash
   node "$TOOLKIT/scripts/team-tasks.mjs" add backend-worker 'Implement the agreed fix' \
     --route opus_patch --accept 'The focused suite passes.'
   node "$TOOLKIT/scripts/team-tasks.mjs" add qa-worker 'Verify the fix' --after 1 \
     --route haiku_fork --accept 'The suite passes and the screenshot shows the label.'
   ```

   Every role except `lead` needs `--accept` (at most 600 characters). `--tag <t>`
   is an optional team label (lowercase letters, digits, hyphens). A team or
   project name is a tag, never a role. A role that is not in the catalog is
   refused, and the error names the catalog; a stored off-catalog role stays
   claimable. Never dispatch `needs_lead` or unresolved holds. Resolve a hold
   with `route <id> <route> --reason "..."` once decided. `add --reason` needs
   `--route`, and `add --by` needs a journaled decision. `--ref` and `--by` are
   trimmed, and a blank value is refused. Re-plan a task blocked by a cancelled
   dependency with `after <id> <id,id|none>`. There is no block command, and never
   bypass a hold by adding a duplicate.


## Read when

| When | Read |
| --- | --- |
| Starting or resuming a team cycle | [operating cycle](references/operating-cycle.md) |
| Preparing work or a recommendation | [owner preferences](references/owner-preferences.md) |
| Choosing a role | [roles](references/roles.md) |
| Writing test tasks and build briefs | [tests first](references/tests-first.md) |
| Writing any delegate brief | `team-tasks.mjs brief <id> --kind <test\|build\|review\|verify>` fills the [template](references/briefs/build.md). Build needs a same-tag `qa-worker` or `--no-test-pair --reason "<text>"` with a nonblank reason |
| Picking an executor, briefing, wake addresses, owner questions, replacing a worker, finishing | [dispatch and finish](references/dispatch.md) |
| Briefing a reviewer or adversary, or any re-check | [PR reviews](references/pr-reviews.md) |
| Jev option choices and receipts | [Jev decisions](references/jev-decisions.md) |
| Jev on browser or device evidence, handoffs, filtering large evidence | [Jev execution](references/jev-execution.md#when-to-cross-check-with-jev) |
| The done gate and judgments | [Jev team](references/jev-team.md) |
| Owner review packets, screenshots, video | [review queue](references/review-queue.md) |
| Writing a project's own worker hooks (spec preflight, verifier briefs, device slots) | [project hook examples](references/project-hooks.md) |

## Board health and verification

Board repair rules, `doctor`, `stale`, `reap` and archive behavior live in
[team-board](../team-board/SKILL.md). After changing the done gate, the journal
or how Jev judgments are recorded, run [verify-team-board](../verify-team-board/SKILL.md).
