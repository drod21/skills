# Shared worker protocol

For authorized task-board team work; standalone advice or edits create no board
tasks. Report to your area lead; send ideas and preference lessons with evidence
to that lead, not to shared memory or the human. Read the owner preferences your
brief names and cite them in the handoff. Product evidence follows the
[delivery evidence rules](../../pr-delivery/SKILL.md). `$TOOLKIT` is
`${DEREK_SKILLS:-$HOME/derek-skills}`; use the coordinator's absolute script paths.

1. **Scope.** Read the assigned scope, the role skill, the project's task map and
   command skill; inspect the tree before edits. Preserve an assigned checkout and
   verify its pinned head. Write files with the harness's edit or write tool,
   never a heredoc, `tee` or redirect. Branch a new unit from the verified remote
   default branch and report if it is behind; a builder continues from its test
   commit, including any lead-approved amendment. Carry another packet's commits
   only when the brief names it. An existing unit branch may be fetched and merged
   before a push. Commit and push at each green step.
2. **Claim.** `node "$TOOLKIT/scripts/team-tasks.mjs" claim <role> <owner> --id
   <id> --run <kind>:<ref> [--wake <threadId>]`, kind `workflow`, `t3_task`,
   `subagent` or `session`. If the lead already claimed for your owner, verify
   that record instead. Without `--id` a claim takes the role's first eligible
   task, possibly another team's: check ID, title and route, and if it is not
   yours, stop and tell the lead. `null` means no eligible work; do not poll or
   steal a claim.
3. **Tests first.** A builder builds against the locked tests and never edits,
   skips, deletes, loosens or re-times a locked file; new tests go in new files. A
   locked test that looks wrong: stop that part, report test, reason and evidence
   to the lead, carry on with the rest. An older test that contradicts a locked
   one: follow the locked test and report the older one with the decision it
   contradicts. A test worker writes tests and the minimal contract, never the
   implementation, and alone amends a locked test, in its own commit, when the
   lead assigns it ([tests first](tests-first.md)). Before the lock it runs the
   affected existing tests, amends or removes in the lock commit each older test
   asserting the opposite of a numbered decision (citing it), and lists them
   ("none" with the command it ran).
4. **Decide inside the boundary.** Facts first, then Jev for semantic judgment:
   `jev-ask.ts --task <id> --by <owner>` (`--preset
   flaky_or_real|blocker_or_nit|clipped_text` or `--pick`), `jev-decide.ts --task
   <id> --by <owner>` for scored options; `jev-route.ts` only routes. On a task
   with `accept`, `--by` is the claim owner; helper subagents pass `--out <dir>`
   and do not write the board. Then the lead, with one narrow question: input and
   result, options, recommendation, blocker. Cross-domain decisions, new
   dependencies, shared-file collisions and missing prerequisites go to the lead.
   Never ask the human directly or send a credential or token to Jev. Records:
   [worker records](worker-records.md). Keep blocked work claimed (only the
   coordinator releases or reaps), `heartbeat <id>` on long tasks, never edit
   board JSON or its lock. Run your adversary review in the foreground. Never end
   a turn to ask, propose a next step or stop after setup; wait out the load guard
   with `uptime`, never override it.
5. **Hand off.** Task and owner, checkout and head, changed files, outcome, checks
   with actual results, evidence paths, blockers. From a worktree, give a commit
   or patch; it does not verify the integrated parent. A diagnosis states
   "reproduced with the owner's inputs: yes/no"; "by design" or "not built yet"
   goes to the owner only with yes. When logic returns the action and the screen
   does not show it, check screen wiring and data-ready timing first.
6. **Complete.** `done <id> --owner <owner>` only after the deliverable and its
   acceptance checks pass. On a gated task, attach evidence first, run `verify-git
   <id> --by <owner>` for a pinned `gitProof`, run `jev-ask.ts --check-evidence
   --summary <text> --task <id> --by <owner>` last, then `done`
   ([evidence gate](worker-evidence-gate.md)). An owner-only question goes on the
   task: `ask-owner <id> <question...> --by <you>`; keep working, `answer-read`
   once read. Never mark unresolved work complete; a review's deliverable
   includes its pushed fixes.
7. **Clean up.** In the closing step, remove your own worktree, simulator,
   containers and temp files, enumerating first and removing only what your
   session created.

## Project hooks

If the project checkout has `.agents/team/project-protocol.md`, read it after
this file: the project's hooks, guards and delivery skill
([examples](project-hooks.md)).
